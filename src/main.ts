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

function statusOk(code: EcsactParseStatusCode): boolean {
	return (
		code == EcsactParseStatusCode.Ok ||
		code == EcsactParseStatusCode.BlockBegin ||
		code == EcsactParseStatusCode.BlockEnd
	);
}

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
	EcsactStatementGeneric<EcsactStatementType.Unknown, null> |
	EcsactStatementGeneric<EcsactStatementType.Package, EcsactPackageStatementData> |
	EcsactStatementGeneric<EcsactStatementType.Import, EcsactImportStatementData> |
	EcsactStatementGeneric<EcsactStatementType.Component, EcsactComponentStatementData> |
	EcsactStatementGeneric<EcsactStatementType.Transient, EcsactTransientStatementData> |
	EcsactStatementGeneric<EcsactStatementType.System, EcsactSystemStatementData> |
	EcsactStatementGeneric<EcsactStatementType.Action, EcsactActionStatementData> |
	EcsactStatementGeneric<EcsactStatementType.Enum, EcsactEnumStatementData> |
	EcsactStatementGeneric<EcsactStatementType.EnumValue, null> |
	EcsactStatementGeneric<EcsactStatementType.BuiltinTypeField, null> |
	EcsactStatementGeneric<EcsactStatementType.UserTypeField, null> |
	EcsactStatementGeneric<EcsactStatementType.EntityField, null> |
	EcsactStatementGeneric<EcsactStatementType.SystemComponent, null> |
	EcsactStatementGeneric<EcsactStatementType.SystemGenerates, null> |
	EcsactStatementGeneric<EcsactStatementType.SystemWithEntity, null> |
	EcsactStatementGeneric<EcsactStatementType.EntityConstraint, null>;

interface EcsactPackageStatementData {
	main: boolean;
	packageName: EcsactParseString;
}

interface EcsactImportStatementData {
	importPackageName: EcsactParseString;
}

interface EcsactComponentStatementData {
	componentName: EcsactParseString;
}

interface EcsactTransientStatementData {
	transientName: EcsactParseString;
}

interface EcsactSystemStatementData {
	systemName: EcsactParseString;
}

interface EcsactActionStatementData {
	actionName: EcsactParseString;
}

interface EcsactEnumStatementData {
	enumName: EcsactParseString;
}

interface EcsactEnumValueStatementData {
	name: EcsactParseString;
	value: number;
}

interface EcsactFieldStatementData {
	fieldType: number; // ecsact_builtin_type
	fieldName: EcsactParseString;
	length: number;
}

interface EcsactUserTypeFieldStatementData {
	userTypeName: EcsactParseString;
	fieldName: EcsactParseString;
	length: number;
}

interface EcsactSystemComponentStatementData {
	capability: number; // ecsact_system_capability
	componentName: EcsactParseString;
	withEntityFieldName: EcsactParseString;
}

interface EcsactSystemWithEntityStatementData {
	withEntityFieldName: EcsactParseString;
}

interface EcsactEntityConstraintStatementData {
	optional: boolean;
	constraintComponentName: EcsactParseString;
}

function getParseStringAt(statementStringStart: number, mem: ArrayBuffer, offset: number): EcsactParseString {
	const i32mem = new Int32Array(mem);
	const u8mem = new Uint8Array(mem);
	const start = i32mem.at(offset / 4)!;
	const len = i32mem.at((offset / 4) + 1)!;

	return {
		value: String.fromCharCode(...Array.from(u8mem.slice(start, start + len))),
		offset: start - statementStringStart,
	};
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
	[EcsactStatementType.None]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Unknown]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.Package]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const readableMemBufferU8 = new Uint8Array(mem);
		const main = readableMemBufferU8.at(offset)!;

		const data: EcsactPackageStatementData = {
			main: !!main,
			packageName: getParseStringAt(statementStringStart, mem, offset + 4),
		};

		return data;
	},
	[EcsactStatementType.Import]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactImportStatementData = {
			importPackageName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.Component]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactComponentStatementData = {
			componentName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.Transient]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactTransientStatementData = {
			transientName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.System]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactSystemStatementData = {
			systemName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.Action]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactActionStatementData = {
			actionName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.Enum]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		const data: EcsactEnumStatementData = {
			enumName: getParseStringAt(statementStringStart, mem, offset),
		};

		return data;
	},
	[EcsactStatementType.EnumValue]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.BuiltinTypeField]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.UserTypeField]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.EntityField]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemComponent]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemGenerates]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.SystemWithEntity]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
	[EcsactStatementType.EntityConstraint]: (statementStringStart: number, mem: ArrayBuffer, offset: number) => {
		return null;
	},
};

function getStatement(statementStringStart: number, mem: ArrayBuffer, offset: number): EcsactStatement {
	const readableMemBuffer = new Int32Array(mem);

	const id = readableMemBuffer.at(offset / 4)!;
	const type = getStatementType(mem, offset);
	const data = statementDataParsers[type](statementStringStart, mem, offset + 8);

	return { id, type, data } as EcsactStatement;
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
	if (statusOk(parseStatus.code)) {
		statement = getStatement(statementStrIndex, mem.buffer, outStatementIndex);
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

class EcsactSemanticTokens implements vscode.DocumentRangeSemanticTokensProvider {
	static legend: vscode.SemanticTokensLegend = {
		tokenModifiers: [],
		tokenTypes: ['keyword', 'namespace', 'type'],
	};

	async provideDocumentRangeSemanticTokens(document: vscode.TextDocument, range: vscode.Range, token: vscode.CancellationToken): Promise<vscode.SemanticTokens> {
		await loadEscactParseWasmIfNeeded();
		const builder = new vscode.SemanticTokensBuilder(EcsactSemanticTokens.legend);

		while (!range.isEmpty) {
			if (token.isCancellationRequested) break;

			const currentLineNo = range.start.line;
			const text = document.getText(range);

			const addToken = (tokenType: number, str: EcsactParseString) => {
				builder.push(currentLineNo, str.offset, str.value.length, tokenType);
			};

			const addKeyword = (keyword: string) => {
				builder.push(currentLineNo, text.indexOf(keyword), keyword.length, 0);
			};

			const result = ecsactParse(text);
			if (statusOk(result.parseStatus.code)) {
				switch (result.statement?.type) {
					case EcsactStatementType.Package:
						if (result.statement!.data.main) addKeyword('main');
						addKeyword('package');
						addToken(1, result.statement!.data.packageName);
						break;
					case EcsactStatementType.Import:
						addKeyword('import');
						addToken(1, result.statement!.data.importPackageName);
						break;
					case EcsactStatementType.Component:
						addKeyword('component');
						addToken(2, result.statement!.data.componentName);
						break;
					case EcsactStatementType.Transient:
						addKeyword('transient');
						addToken(2, result.statement!.data.transientName);
						break;
					case EcsactStatementType.System:
						addKeyword('system');
						addToken(2, result.statement!.data.systemName);
						break;
					case EcsactStatementType.Action:
						addKeyword('action');
						addToken(2, result.statement!.data.actionName);
						break;
					case EcsactStatementType.Enum:
						addKeyword('enum');
						addToken(2, result.statement!.data.enumName);
						break;
				}

				const startDelta = {
					lineDelta: 0,
					characterDelta: 0,
				};
				for (let i = 0; result.readAmount > i; ++i) {
					if (text[i] == '\n') {
						startDelta.lineDelta += 1;
						startDelta.characterDelta = 0;
					} else {
						startDelta.characterDelta += 1;
					}
				}

				range = range.with(range.start.translate(startDelta));
			} else {
				// const lineIndex = text.indexOf('\n');
				// const semiColonIndex = text.indexOf(';');

				// const startDelta = {
				// 	lineDelta: 0,
				// 	characterDelta: 0,
				// };

				// if (lineIndex != -1 && semiColonIndex != -1) {
				// 	if (semiColonIndex < lineIndex) {
				// 		startDelta.characterDelta = semiColonIndex + 1;
				// 	} else {
				// 		startDelta.lineDelta = 1;
				// 	}
				// } else if (lineIndex != -1) {
				// 	startDelta.lineDelta = 1;
				// } else if (semiColonIndex != -1) {
				// 	startDelta.characterDelta = semiColonIndex + 1;
				// } else {
				// 	break;
				// }

				// range = range.with(range.start.translate(startDelta));
				break;
			}
		}

		return builder.build();
	}
}

export async function activate(context: vscode.ExtensionContext) {
	disposables.push(
		vscode.commands.registerCommand('ecsact.restart-lang-server', async () => {
			await client!.restart().catch(catchLangServerError);
		}),
		vscode.languages.registerDocumentRangeSemanticTokensProvider(
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
