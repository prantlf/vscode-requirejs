const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const requirejs = require('requirejs');
const amodroConfig = require('amodro-trace/config');
const amodroParse = require('./lib/parse');
const LRU = require('lru-cache');

// Initialize or re-initialize requirejs for the activated context.
function initializeRequireJs () {
	const requireModuleSupport = vscode.workspace.getConfiguration('requireModuleSupport');
	const rootPath = vscode.workspace.rootPath;

	// Clean up requirejs configuration from the previously activated context.
	// See https://github.com/requirejs/requirejs/issues/1113 for more information.
	delete requirejs.s.contexts._;

	// Handle the existing modulePath property as baseUrl for require.config()
	// to support simple scenarios. More complex projects should supply also
	// configFile in addition to baseUrl to resolve any module path.
	requirejs.config({ baseUrl: path.join(rootPath, requireModuleSupport.get('modulePath')) });

	// Reuse the configuration for debugging a requirejs project for editing too.
	// Prevent maintaining the same configuration in settings.json.
	const configFile = requireModuleSupport.get('configFile');

	if (configFile) {
		const configContent = fs.readFileSync(path.join(rootPath, configFile), 'utf-8');
		const config = amodroConfig.find(configContent);

		if (config) {
			requirejs.config(config);
		}
	}
}

// Gets a cached object for the specified document version. If the cache was
// popupated for other document version, it rtemoves the object from the cache
// and returns nothing.
function getCachedVersionedObject (cache, document) {
	const fileName = document.fileName;
	let cacheEntry = cache.get(fileName);

	if (cacheEntry) {
		if (cacheEntry.version !== document.version) {
			cache.del(fileName);
		} else {
			return cacheEntry.object;
		}
	}

	return null;
}

// Sets a object to cache for the specified document version.
function setCachedVersionedObject (cache, document, object) {
	cache.set(document.fileName, {
		object: object,
		version: document.version
	});
}

class ReferenceProvider {
	constructor () {
		this.moduleDependencyCache = new LRU(100);
		this.parsedModuleCache = new LRU(100);
	}

	/**
		 * Returns obj with name/path pairs from define/require statement
		 * @param {TextDocument} document Original document
		 * @param {String} textContent String to process
		 * @returns {Object} Contains name/path pairs
		 */
	getModuleDependencies (document, textContent) {
		const fileName = document.fileName;
		let dependencies = getCachedVersionedObject(this.moduleDependencyCache, document);
		let params;

		if (!dependencies) {
			let astRoot = getCachedVersionedObject(this.parsedModuleCache, document);

			dependencies = amodroParse.findDependencies2(fileName, astRoot || textContent, { loc: true });
			if (!astRoot) {
				setCachedVersionedObject(this.parsedModuleCache, document, dependencies.astRoot);
			}
			dependencies = {
				modules: dependencies.modules,
				params: dependencies.params
			};
			setCachedVersionedObject(this.moduleDependencyCache, document, dependencies);
		}

		params = dependencies.params;
		dependencies = dependencies.modules;

		return params.reduce(function (result, param, index) {
			result[param] = dependencies[index];

			return result;
		}, {});
	}

	/**
		 * Returns start/end with line/character location of the identifier occurrence range in the text content
		 * @param {TextDocument} document Original document
		 * @param {String} textContent String to process
		 * @param {String} identifier Identifier to look for
		 * @returns {Object} Contains start/end object with a pair of line/character objects
		 */
	findIdentifierLocation (document, textContent, identifier) {
		const fileName = document.fileName;
		let astRoot = getCachedVersionedObject(this.parsedModuleCache, document);
		const location = amodroParse.findIdentifier(fileName, astRoot || textContent, identifier, { loc: true });
		const loc = location.loc;

		if (!astRoot) {
			setCachedVersionedObject(this.parsedModuleCache, document, location.astRoot);
		}

		return loc;
	}

	/**
		 * Computes an absolute path to the file representing the RequireJS module dependency.
		 * @param {String} modulePath Require path of the target module
		 * @param {String} currentFilePath Current file path to start search from
		 * @returns {String} the file location
		 */
	resolveModulePath (modulePath, currentFilePath) {
		// Plugins, which load other files follow the syntax "plugin!parameter",
		// where "parameter" is usually another module path to be resolved.
		const pluginSeparator = modulePath.indexOf('!');
		let filePath;

		if (pluginSeparator > 0) {
			const pluginExtensions = vscode.workspace.getConfiguration('requireModuleSupport').get('pluginExtensions');
			const pluginName = modulePath.substr(0, pluginSeparator);

			filePath = modulePath.substr(pluginSeparator + 1);
			// Plugins may optionally append their known file extensions.
			if (pluginExtensions) {
				const pluginExtension = pluginExtensions[pluginName];

				if (pluginExtension && !filePath.endsWith(pluginExtension)) {
					filePath += pluginExtension;
				}
			}
		} else {
			// The requirejs.toUrl method does not append '.js' to the resolved path.
			filePath = modulePath + '.js';
		}

		// The global requirejs.toUrl does not resolve relative module paths.
		if (filePath.startsWith('./')) {
			filePath = path.join(path.dirname(currentFilePath), filePath);
		}

		return path.normalize(requirejs.toUrl(filePath));
	}

	/**
		 * Diverges the search to the given module
		 * @param {String} currentFilePath Current file path to start search from
		 * @param {String} modulePath Require path of the target module
		 * @param {String} searchFor The string to search for inside the module
		 * @param {Bool} stopSearchingFurther If set to true, do not continue following definitions.
		 * @returns {Promise} resolves with file location
		 */
	searchModule (currentFilePath, modulePath, searchFor) {
		const newUri = vscode.Uri.file(this.resolveModulePath(modulePath, currentFilePath));
		const newDocument = vscode.workspace.openTextDocument(newUri);

		return newDocument.then(doc => {
			const onlyNavigateToFile = vscode.workspace.getConfiguration('requireModuleSupport').get('onlyNavigateToFile');

			if (!onlyNavigateToFile && searchFor) {
				const fullText = doc.getText();
				const foundAt = this.findIdentifierLocation(doc, fullText, searchFor);

				if (foundAt) {
					return new vscode.Location(newUri, new vscode.Range(
						new vscode.Position(foundAt.start.line - 1, foundAt.start.column),
						new vscode.Position(foundAt.end.line - 1, foundAt.end.column)
					));
				}
			}

			return new vscode.Location(newUri, new vscode.Position(0, 0));
		});
	}

	provideDefinition (document, position) {
		const fullText = document.getText();
		const currentFilePath = document.fileName;
		const range = document.getWordRangeAtPosition(position);

		if (range) {
			const textAtCaret = document.getText(range);
			const moduleDependencies = this.getModuleDependencies(document, fullText);
			let modulePath = moduleDependencies[textAtCaret];

			if (modulePath) {
				return this.searchModule(currentFilePath, modulePath, textAtCaret);
			}
		}

		return Promise.resolve(undefined);
	}
}

Object.assign(exports, {
	ReferenceProvider,
	activate (context) {
		initializeRequireJs();
		context.subscriptions.push(
			vscode.languages.registerDefinitionProvider(
				'javascript',
				new ReferenceProvider()
			)
		);
	}
});
