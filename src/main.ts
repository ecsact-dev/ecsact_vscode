import * as path from 'path';
import { workspace, ExtensionContext, commands } from 'vscode';

import {
	Executable,
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

function getLspExecutable(): Executable {
	const defaultExecutable = workspace.getConfiguration('ecsact.lsp.executable.default');
	const platformExecutable = workspace.getConfiguration(`ecsact.lsp.executable.${process.platform}`);

	const command =
		platformExecutable.get<string>('command') ||
		defaultExecutable.get<string>('command') || 'ecsact_lsp_server';

	const args =
		platformExecutable.get<string[]>('args') ||
		defaultExecutable.get<string[]>('args') || [];

	return { command, args, transport: TransportKind.stdio };
}

export function activate(context: ExtensionContext) {

	context.subscriptions.push(
		workspace.onDidChangeConfiguration(e => {
			console.log(e);
		}),
		commands.registerCommand('ecsact.lsp.restart', () => {
			client?.restart();
		}),
	);

	const serverOptions: ServerOptions = getLspExecutable();

	const clientOptions: LanguageClientOptions = {
		documentSelector: [{ scheme: 'file', language: 'ecsact' }],
		synchronize: {
			fileEvents: workspace.createFileSystemWatcher('**/*.ecsact'),
		}
	};

	// Create the language client and start the client.
	client = new LanguageClient(
		'EcsactLSP',
		'Ecsact LSP',
		serverOptions,
		clientOptions
	);

	// Start the client. This will also launch the server
	client.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return;
	}
	return client.stop();
}
