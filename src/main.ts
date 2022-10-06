import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { LanguageClient, LanguageClientOptions } from 'vscode-languageclient/node';

let client: LanguageClient;
const ecsactparseWasmPath = path.resolve(__dirname, '../ecsact_parse.wasm');
const disposables: vscode.Disposable[] = [];
let _ecsactParse: WebAssembly.Instance | null = null;

function catchLangServerError(err: any) {
	console.error(`[Ecsact Lang Server]`, err.message);
}

enum EcsactStatementType {
	None,
	Unknown,
	Package,
	Import,
	Component,
	Transient,
	System,
	Action,
	Enum,
	EnumValue,
	BuiltinTypeField,
	UserTypeField,
	EntityField,
	SystemComponent,
	SystemGenerates,
	SystemWithEntity,
	EntityConstraint,
};

enum EcsactParseStatusCode {
	Ok,
	BlockBegin,
	BlockEnd,
	ExpectedStatementEnd,
	UnexpectedEof,
	SyntaxError,
};

interface EcsactParseString {
	value: string;
	offset: number;
}

interface EcsactParseStatus {
	code: EcsactParseStatusCode;
	errorLocation: EcsactParseString;
}

interface EcsactStatementGeneric<Type extends EcsactStatementType, Data> {
	id: number;
	type: Type;
	data: Data;
}

type EcsactStatement =
	EcsactStatementGeneric<EcsactStatementType.None, null> |
	EcsactStatementGeneric<EcsactStatementType.Package, EcsactPackageStatementData>;

interface EcsactPackageStatementData {
	main: boolean;
	packageName: EcsactParseString;
}

function getParseStatus(mem: ArrayBuffer, offset: number): EcsactParseStatus {
	const readableMemBuffer = new Int32Array(mem);
	return {
		code: readableMemBuffer.at(offset / 4) as EcsactParseStatusCode,
		errorLocation: {
			offset: 0,
			value: '',
		},
	};
}

function getStatementType(mem: ArrayBuffer, offset: number): EcsactStatementType {
	const readableMemBuffer = new Int32Array(mem);
	return readableMemBuffer.at((offset / 4) + 1)! as EcsactStatementType;
}

const statementDataParsers = {
	[EcsactStatementType.None]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Unknown]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Package]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Import]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Component]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Transient]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.System]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Action]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Enum]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.EnumValue]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.BuiltinTypeField]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.UserTypeField]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.EntityField]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemComponent]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemGenerates]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemWithEntity]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.EntityConstraint]: (mem: ArrayBuffer, offset: number) => {
		return null;
	},
};

function getStatement(mem: ArrayBuffer, offset: number): EcsactStatement | null {
	const readableMemBuffer = new Int32Array(mem);

	const id = readableMemBuffer.at(offset / 4)!;
	const type = getStatementType(mem, offset);

	return statementDataParsers[type](mem, offset + 12);
}

interface EcsactParseResult {
	readAmount: number;
	parseStatus: EcsactParseStatus;
	statement: EcsactStatement | null;
}

function ecsactParse(statementString: string): EcsactParseResult {
	const stackAlloc = _ecsactParse!.exports.stackAlloc as Function;
	const stackRestore = _ecsactParse!.exports.stackRestore as Function;
	const stackSave = _ecsactParse!.exports.stackSave as Function;
	const fn = _ecsactParse!.exports.ecsact_parse_statement as Function;
	const mem = _ecsactParse!.exports.memory as WebAssembly.Memory;
	const byteView = new Uint8Array(mem.buffer);

	const stack = stackSave();

	const statementStrIndex = stackAlloc(statementString.length);
	byteView.set(Array.from(statementString).map(c => c.charCodeAt(0)), statementStrIndex);
	const outStatementIndex = stackAlloc(64);
	const outStatusIndex = stackAlloc(32);

	const readAmount = fn(statementStrIndex, statementString.length, 0, outStatementIndex, outStatusIndex);

	const parseStatus = getParseStatus(mem.buffer, outStatusIndex);
	let statement: EcsactStatement | null = null;
	switch (parseStatus.code) {
		case EcsactParseStatusCode.Ok:
		case EcsactParseStatusCode.BlockBegin:
		case EcsactParseStatusCode.BlockEnd:
			statement = getStatement(mem.buffer, outStatementIndex);
			break;
	}

	stackRestore(stack);

	return { parseStatus, readAmount, statement };
}

async function loadEscactParseWasm() {
	const source = new Uint8Array(await fs.readFile(ecsactparseWasmPath));
	const imports: WebAssembly.Imports = {
		'wasi_snapshot_preview1': {
			'proc_exit': () => {
				console.log('proc_exit called');
			},
			'fd_close': () => { },
			'fd_write': () => { },
			'fd_seek': () => { },
		},
	};
	const { instance } = await WebAssembly.instantiate(source, imports);
	if (typeof instance.exports._initialize === 'function') {
		instance.exports._initialize();
	}

	_ecsactParse = instance;
}

async function loadEscactParseWasmIfNeeded() {
	if (!_ecsactParse) {
		await loadEscactParseWasm();
	}
}

class EcsactSemanticTokens implements vscode.DocumentSemanticTokensProvider {
	static legend: vscode.SemanticTokensLegend = {
		tokenModifiers: [],
		tokenTypes: [],
	};

	async provideDocumentSemanticTokens(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<vscode.SemanticTokens> {
		await loadEscactParseWasmIfNeeded();
		const builder = new vscode.SemanticTokensBuilder(EcsactSemanticTokens.legend);

		let lineCount = document.lineCount;
		let currentLineNo = -1;

		while (lineCount > currentLineNo + 1) {
			const currentLine = document.lineAt(++currentLineNo);
			const result = ecsactParse(currentLine.text);
			console.log(currentLine.text, result);
		}

		return builder.build();
	}
}

export async function activate(context: vscode.ExtensionContext) {
	disposables.push(
		vscode.commands.registerCommand('ecsact.restart-lang-server', async () => {
			await client!.restart().catch(catchLangServerError);
		}),
		vscode.languages.registerDocumentSemanticTokensProvider(
			{ language: 'ecsact' },
			new EcsactSemanticTokens(),
			EcsactSemanticTokens.legend,
		),
	);


	// client = new LanguageClient(
	// 	'ecsact',
	// 	'Ecsact',
	// 	{ command: '/home/ezekiel/projects/seaube/ecsact/bazel-bin/lang-server/ecsact-lang-server' },
	// 	{ documentSelector: [{ language: 'ecsact' }] },
	// 	true,
	// );

	// await client.start().catch(catchLangServerError);
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
