const sinon = require('sinon');
const proxyquire = require('proxyquire');
const assert = require('assert');
const registerDefinitionProviderStub = sinon.stub();
const vscodeStub = { languages: { registerDefinitionProvider: registerDefinitionProviderStub } };
const extension = proxyquire('../extension', { vscode: vscodeStub });

suite('extension', () => {
	test('should export activate method', () => {
		assert.ok('activate' in extension);
	});

	test('activate should register definition provider', () => {
		const context = { subscriptions: [] };

		extension.activate(context);

		// Registering the RequireJS definition provider,
		// reinitializing RequireJS on configuration change,
		// clearing caches on on document change
		// and clearing caches on on document close.
		assert.equal(context.subscriptions.length, 4);
		assert.deepEqual(
			registerDefinitionProviderStub.getCall(0).args,
			[
				'javascript',
				new extension.ReferenceProvider()
			]
		);
	});
});
