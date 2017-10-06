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

class ReferenceProvider {
	constructor () {
		this.moduleDependencyCache = new LRU(100);
		this.fileContentCache = new LRU(100);
	}

	/**
		 * Returns obj with name/path pairs from define/require statement
		 * @param {TextDocument} document Original document
		 * @param {String} textContent String to process
		 * @returns {Object} Contains name/path pairs
		 */
	getModuleDependencies (document, textContent) {
		const fileName = document.fileName;
		let cacheEntry = this.moduleDependencyCache.get(fileName);
		let dependencies;

		if (cacheEntry) {
			if (cacheEntry.version !== document.version) {
				this.moduleDependencyCache.del(fileName);
				cacheEntry = null;
			}
		}
		if (!cacheEntry) {
			cacheEntry = {
				dependencies: amodroParse.findDependencies(fileName, textContent, {}),
				version: document.version
			};
			this.moduleDependencyCache.set(fileName, cacheEntry);
		}
		dependencies = cacheEntry.dependencies;

		return dependencies.params.reduce(function (result, param, index) {
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
		let cacheEntry = this.fileContentCache.get(fileName);

		if (cacheEntry) {
			if (cacheEntry.version !== document.version) {
				this.fileContentCache.del(fileName);
				cacheEntry = null;
			}
		}

		const result = amodroParse.findIdentifier(cacheEntry && cacheEntry.astRoot || textContent, identifier);
		const location = result.location;

		if (!cacheEntry) {
			cacheEntry = {
				astRoot: result.astRoot,
				version: document.version
			};
			this.fileContentCache.set(fileName, cacheEntry);
		}

		return location && amodroParse.convertRangeToPositions(textContent, location);
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
						new vscode.Position(foundAt.start.line, foundAt.start.character),
						new vscode.Position(foundAt.end.line, foundAt.end.character)
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
