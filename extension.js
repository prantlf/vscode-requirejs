const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const requirejs = require('requirejs');
const amodroConfig = require('amodro-trace/config');
const amodroParse = require('./lib/parse');
const LRU = require('lru-cache');

/**
	 * Initializes or re-initializes requirejs for the activated context.
	 * @returns {void} Nothing
	 */
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

/**
	 * Computes an absolute path to the file representing the RequireJS module dependency.
	 * @param {String} modulePath Require path of the target module
	 * @param {String} currentFilePath Current file path to start search from
	 * @returns {String} the file location
	 */
function resolveModulePath (modulePath, currentFilePath) {
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
	 * Gets a cached object for the specified document version. If the cache was populated
	 * for other document version, it removes the object from the cache and returns nothing.
	 * @param {Object} cache LRU cache to use
	 * @param {TextDocument} document Original document
	 * @returns {Object} The cached objecty or null
	 */
function getCachedVersionedObject (cache, document) {
	const fileName = document.fileName;
	let cacheEntry = cache.get(fileName);

	if (cacheEntry) {
		// The version property changes with every document modification.
		if (cacheEntry.version !== document.version) {
			cache.del(fileName);
		} else {
			return cacheEntry.object;
		}
	}

	return null;
}

/**
	 * Sets a object to cache for the specified document version.
	 * @param {Object} cache LRU cache to use
	 * @param {TextDocument} document Original document
	 * @param {Object} object Object to store to the cache
	 * @returns {void} Nothing
	 */
function setCachedVersionedObject (cache, document, object) {
	cache.set(document.fileName, {
		object: object,
		version: document.version
	});
}

/**
	 * Returns AST nodes for the identifier the expression around it, or nothing,
	 * if there is no identifier within the specified range.
	 * @param {Object} astRoot Parsed document
	 * @param {Object} range Range, where the identifier is supposed to be
	 * @returns {Object} Contains currentNode and parentNode objects
	 */
function findIdentifierWinthinRange (astRoot, range) {
	// vscode.Range is zero-based, esprima's one-based
	const line = range.start.line + 1;
	const column = range.start.character;
	let currentNode, parentNode;

	amodroParse.traverse(astRoot, function (node, parent) {
		if (node) {
			let loc = node.loc;

			if (loc) {
				let start = loc.start;

				// The selected range has to be an identifier to be valid for "Go to Definition".
				if (node.type === 'Identifier' && start.line === line && start.column === column) {
					currentNode = node;
					parentNode = parent;

					return false;
				}
				// Stop traversing, if we passed the line with the caret selection.
				if (loc.line > line) {
					return false;
				}
			}
		}

		return true;
	});

	return currentNode && {
		currentNode: currentNode,
		parentNode: parentNode
	};
}

/**
	 * Returns identifiers for the "Go to Definition lookup. The "imported" one used
	 * as formal parameter for the dependent module's export and the "selected" one,
	 * which is either the same one, or is child property, which eas selected.
	 * @param {Object} identifier AST nodes for the selected identifier
	 * @returns {Object} Contains currentNode and parentNode objects
	 */
function getIdentifiersToSearchFor (identifier) {
	const parentNode = identifier.parentNode;
	const selected = identifier.currentNode.name;
	let imported;

	if (parentNode) {
		// Support selecting "member" within a "object.member" expression.
		if (parentNode && parentNode.type === 'MemberExpression' && parentNode.computed === false
			&& parentNode.property && parentNode.property.name === selected && parentNode.object) {
			imported = parentNode.object.name;
		}
	}

	// Exported identifiers usually equal to formal parameters used for importing.
	return {
		imported: imported || selected,
		selected: selected
	};
}

class ReferenceProvider {
	constructor () {
		this.moduleDependencyCache = new LRU(100);
		this.parsedModuleCache = new LRU(100);
	}

	/**
		 * Returns AST of the specified document to beused in other functions
		 * @param {TextDocument} document Original document
		 * @returns {Object} JavaScript AST
		 */
	getParsedModule (document) {
		let astRoot = getCachedVersionedObject(this.parsedModuleCache, document);

		if (!astRoot) {
			astRoot = amodroParse.parseFileContents(document.fileName, document.getText(), { loc: true });
			setCachedVersionedObject(this.parsedModuleCache, document, astRoot);
		}

		return astRoot;
	}

	/**
		 * Returns obj with name/path pairs from define/require statement
		 * @param {TextDocument} document Original document
		 * @param {Object} astRoot Parsed document
		 * @returns {Object} Contains name/path pairs
		 */
	getModuleDependencies (document, astRoot) {
		let dependencies = getCachedVersionedObject(this.moduleDependencyCache, document);
		let modules;

		if (!dependencies) {
			dependencies = amodroParse.findDependenciesWithParams(document.fileName, astRoot);
			setCachedVersionedObject(this.moduleDependencyCache, document, dependencies);
		}
		modules = dependencies.modules;

		return dependencies.params.reduce(function (result, param, index) {
			result[param] = modules[index];

			return result;
		}, {});
	}

	/**
		 * Diverges the search to the given module
		 * @param {String} currentFilePath Current file path to start search from
		 * @param {String} modulePath Require path of the target module
		 * @param {String} searchFor The identifier to search for inside the module
		 * @returns {Promise} Resolves with a file location
		 */
	searchModule (currentFilePath, modulePath, searchFor) {
		const newUri = vscode.Uri.file(resolveModulePath(modulePath, currentFilePath));
		const newDocument = vscode.workspace.openTextDocument(newUri);

		return newDocument.then(document => {
			const onlyNavigateToFile = vscode.workspace.getConfiguration('requireModuleSupport').get('onlyNavigateToFile');

			// Some modules are source for RequireJS plugins and need not be written in JavaScript.
			if (!onlyNavigateToFile && searchFor && document.languageId === 'javascript') {
				const astRoot = this.getParsedModule(document);
				const location = amodroParse.findIdentifier(document.fileName, astRoot, searchFor);
				const range = location.loc;

				if (range) {
					return new vscode.Location(newUri, new vscode.Range(
						// vscode.Range is zero-based, esprima's one-based
						new vscode.Position(range.start.line - 1, range.start.column),
						new vscode.Position(range.end.line - 1, range.end.column)
					));
				}
			}

			return new vscode.Location(newUri, new vscode.Position(0, 0));
		});
	}

	provideDefinition (document, position) {
		const currentFilePath = document.fileName;
		const range = document.getWordRangeAtPosition(position);

		if (range) {
			const astRoot = this.getParsedModule(document);
			const identifier = findIdentifierWinthinRange(astRoot, range);

			if (identifier) {
				const moduleDependencies = this.getModuleDependencies(document, astRoot);
				const searchFor = getIdentifiersToSearchFor(identifier);
				let modulePath = moduleDependencies[searchFor.imported];

				if (modulePath) {
					return this.searchModule(currentFilePath, modulePath, searchFor.selected);
				}
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
