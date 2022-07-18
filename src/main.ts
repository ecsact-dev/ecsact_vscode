import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions } from 'vscode-languageclient/node';

let client: LanguageClient;
const disposables: vscode.Disposable[] = [];

function catchLangServerError(err: any) {
	console.error(`[Ecsact Lang Server]`, err.message);
}

export async function activate(context: vscode.ExtensionContext) {
	disposables.push(vscode.commands.registerCommand('ecsact.restart-lang-server', async () => {
		await client!.restart().catch(catchLangServerError);
	}));

	client = new LanguageClient(
		'ecsact',
		'Ecsact',
		{ command: '/home/ezekiel/projects/seaube/ecsact/bazel-bin/lang-server/ecsact-lang-server' },
		{ documentSelector: [{ language: 'ecsact' }] },
		true,
	);

	await client.start().catch(catchLangServerError);
}

export async function deactivate() {
	if (client?.needsStop()) {
		await client.stop().catch(catchLangServerError);
	}

	while (disposables.length > 0) {
		disposables.pop()!.dispose();
	}

	await client?.dispose();
}
