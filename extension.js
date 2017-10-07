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
	 * Finds the first occurrence of the specified identifier.
	 * @param {Object} astRoot Parsed document
	 * @param {String} identifier Identifier to look for
	 *
	 * @returns {Object} Range, where the identifer was found as
	 * {start,end} object with {line,column} sub-objects.
	 */
function findIdentifier (astRoot, identifier) {
	let loc;

	amodroParse.traverse(astRoot, node => {
		if (node && node.type === 'Identifier' && node.name === identifier) {
			loc = node.loc;

			return false;
		}

		return true;
	});

	return loc;
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
	 * Returns map of local variables and their initializing ones from expressions,
	 * which just assign one identifier to another, or assign a variable a value
	 * by a "new" expression.
	 * @param {Object} astRoot Parsed document
	 * @param {Object} stopNode Node, which the declarations have to preceede
	 * @returns {Object} Contains currentNode and parentNode objects
	 */
function getVariableAssignments (astRoot, stopNode) {
	const assignments = {};

	function handleAssignment (leftNodeName, rightNode) {
		if (rightNode) {
			if (rightNode.type === 'Identifier') {
				// Suport assignment "... = imported;"
				assignments[leftNodeName] = rightNode.name;
			} else if (rightNode.type === 'NewExpression') {
				// Suport assignment "... = new Imported;"
				let callee = rightNode.callee;

				if (callee && callee.type === 'Identifier') {
					assignments[leftNodeName] = callee.name;
				}
			}
		}
	}

	amodroParse.traverse(astRoot, function (node) {
		if (node === stopNode) {
			return false;
		}

		if (node) {
			if (node.type === 'VariableDeclarator') {
				// Suport declaration "var local = imported;"
				if (node.id && node.id.type === 'Identifier' && node.init) {
					handleAssignment(node.id.name, node.init);
				}
			} else if (node.type === 'AssignmentExpression') {
				// Suport assignment "local = imported;"
				if (node.left && node.left.type === 'Identifier' && node.right) {
					handleAssignment(node.left.name, node.right);
				}
			}
		}

		return true;
	});

	return assignments;
}

/**
	 * Returns identifiers for the "Go to Definition lookup. The "imported" one used
	 * as formal parameter for the dependent module's export and the "selected" one,
	 * which is either the same one, or is child property, which eas selected.
	 * @param {Object} astRoot Parsed document
	 * @param {Object} identifier AST nodes for the selected identifier
	 * @param {Object} moduleDependencies Map of formal parameter name to RequireJS module name
	 * @returns {Object} Contains currentNode and parentNode objects
	 */
function findOriginatingModuleDependency (astRoot, identifier, moduleDependencies) {
	const parentNode = identifier.parentNode;
	const currentNode = identifier.currentNode;
	let selected = currentNode.name;
	let imported, isMember;

	if (parentNode) {
		let property = parentNode.property;
		let object = parentNode.object;

		// Support selecting "member" within a "object.member" expression, otherwise
		// just take the selected identifer as the symbol to look for.
		if (parentNode.type === 'MemberExpression' && parentNode.computed === false
			&& property && property.name === selected && object) {
			if (object.type === 'Identifier') {
				imported = parentNode.object.name;
				isMember = true;
			} else {
				let callee = object.callee;
				let parameters = object.arguments;

				// Support selecting "member" within a "require('module').member" expression.
				if (object.type === 'CallExpression' && callee.type === 'Identifier'
					&& (callee.name === 'require' || callee.name === 'requirejs')
					&& parameters && parameters.length === 1) {
					let firstParameter = parameters[0];

					if (firstParameter && firstParameter.type === 'Literal') {
						return {
							modulePath: firstParameter.value,
							selected: selected
						};
					}
				}
			}
		}
	}
	if (!imported) {
		imported = selected;
	}

	// Exported identifiers usually equal to formal parameters used for importing.
	let modulePath = moduleDependencies[imported];

	// If the identifier is missing among the formal parameters, it may be declared
	// locally and assigned the imported dependency.
	if (!modulePath) {
		const assignments = getVariableAssignments(astRoot, currentNode);

		for (;;) {
			let declared = assignments[imported];

			if (!declared) {
				break;
			}
			// Prevent endless loop, if the code is invalid and contains a declaration
			// with the variable and the expression the other way round.
			delete assignments[imported];
			imported = declared;

			modulePath = moduleDependencies[imported];
			if (modulePath) {
				// If the real import was just renamed by a declaration, look for
				// the real name in the originating module.
				if (!isMember) {
					selected = imported;
				}
				break;
			}
		}
	}

	return {
		modulePath: modulePath,
		imported: imported,
		selected: selected
	};
}

class ReferenceProvider {
	/**
		 * Initializes a new instance.
		 */
	constructor () {
		const moduleCacheSize = vscode.workspace.getConfiguration('requireModuleSupport').get('moduleCacheSize') || 100;

		this.moduleDependencyCache = new LRU(moduleCacheSize);
		this.parsedModuleCache = new LRU(moduleCacheSize);
	}

	/**
		 * Clears internal caches to get to the state of the new inbstance.
		 * @returns {Void} Nothing
		 */
	clearVersionObjectCaches () {
		this.moduleDependencyCache.reset();
		this.parsedModuleCache.reset();
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

		if (!dependencies) {
			dependencies = amodroParse.findDependencies(document.fileName, astRoot);
			dependencies = dependencies.params.reduce(function (result, param, index) {
				result[param] = dependencies[index];

				return result;
			}, {});
			setCachedVersionedObject(this.moduleDependencyCache, document, dependencies);
		}

		return dependencies;
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
				const range = findIdentifier(astRoot, searchFor);

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
				const moduleDependency = findOriginatingModuleDependency(astRoot, identifier, moduleDependencies);
				const modulePath = moduleDependency.modulePath;

				if (modulePath) {
					return this.searchModule(currentFilePath, modulePath, moduleDependency.selected);
				}
			}
		}

		return Promise.resolve(undefined);
	}
}

Object.assign(exports, {
	ReferenceProvider,
	activate (context) {
		const referenceProvider = new ReferenceProvider();

		initializeRequireJs();
		context.subscriptions.push(
			vscode.workspace.onDidChangeConfiguration(() => {
				initializeRequireJs();
				referenceProvider.clearVersionObjectCaches();
			}));
		context.subscriptions.push(
			vscode.languages.registerDefinitionProvider(
				'javascript', referenceProvider
			)
		);
	}
});
