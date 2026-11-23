// FUNC-06: the TypeScript types of the main responses against the shapes of the Rust JSON. The shapes are written by
// backend/tests/contract.rs into tests/contract/*.json. Every field a type declares must be sent by the server, as
// required if the type says so, with a JSON type and nullability the type accepts. Fields only the server knows are fine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

type Shape = {
  kind?: 'scalar' | 'object' | 'array' | 'map' | 'unknown';
  nullable?: boolean;
  types?: string[];
  fields?: Record<string, { required: boolean; shape: Shape }>;
  items?: Shape;
  values?: Shape;
};
/** Where the types of a snapshot are declared: the exported types by name, or the type argument of `api<T>('<path>')`. */
type Source = { type: [file: string, name: string] } | { call: string };

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOTS: Record<string, Source[]> = {
  wishlist: [{ call: '/wishlist' }],
  library: [{ call: '/library' }],
  'price-badges': [{ call: '/wishlist/price-badges' }],
  // The path of this call is a variable, and the price tab and the history tab read it.
  offers: [{ type: ['src/features/offers-model.ts', 'OffersView'] }],
  'fetch-status': [{ call: '/status/fetch' }],
  counts: [{ call: '/counts' }],
  alerts: [{ call: '/alerts' }],
  cart: [{ call: '/cart' }],
};
/** Optional fields of a type the server never sends for this response ("snapshot:path"): the library has no badges. */
const NOT_SENT = new Set<string>(['library:[].price_badge', 'library:[].offer_count']);

function load() {
  const config = ts.readConfigFile(resolve(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return { program, checker: program.getTypeChecker() };
}
const { program, checker } = load();

function declared(file: string, name: string): ts.Type {
  const source = program.getSourceFile(resolve(root, file));
  assert.ok(source, file);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(source)!).find(s => s.name === name);
  assert.ok(symbol, `${name} is not exported by ${file}`);
  return checker.getDeclaredTypeOfSymbol(symbol);
}

/** The types of every `api<T>('<path>', …)` call in src with this literal path. */
function calls(path: string): ts.Type[] {
  const found: ts.Type[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'api' && node.typeArguments?.length === 1) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first) && first.text === path) found.push(checker.getTypeFromTypeNode(node.typeArguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  for (const file of program.getSourceFiles()) if (file.fileName.startsWith(resolve(root, 'src') + '/')) visit(file);
  return found;
}

const has = (type: ts.Type, flag: ts.TypeFlags) => (type.flags & flag) !== 0;

/** Problems of the server shape against a type, as readable paths. */
function compare(name: string, type: ts.Type, shape: Shape, path: string, problems: string[]): void {
  if (has(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
  const members = type.isUnion() ? type.types : [type];
  const nullish = members.some(m => has(m, ts.TypeFlags.Null));
  if (shape.nullable && !nullish) problems.push(`${path}: the server can send null, the type does not allow it`);
  const rest = members.filter(m => !has(m, ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void));
  if (!shape.kind || shape.kind === 'unknown' || rest.length === 0) return;
  // A union of object types or of literals: the shape must fit at least one member.
  if (rest.length > 1 && !rest.every(m => has(m, ts.TypeFlags.BooleanLike | ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike))) {
    const attempts = rest.map(m => {
      const own: string[] = [];
      compare(name, m, shape, path, own);
      return own;
    });
    if (!attempts.some(own => own.length === 0)) problems.push(...attempts.sort((a, b) => a.length - b.length)[0]);
    return;
  }
  if (shape.kind === 'scalar') {
    const accepts = new Set(
      rest.flatMap(m => [
        has(m, ts.TypeFlags.StringLike) && 'string',
        has(m, ts.TypeFlags.NumberLike) && 'number',
        has(m, ts.TypeFlags.BooleanLike) && 'boolean',
      ]),
    );
    for (const sent of shape.types!) if (!accepts.has(sent)) problems.push(`${path}: the server sends ${sent}, the type is ${checker.typeToString(type)}`);
    return;
  }
  const [member] = rest;
  if (shape.kind === 'array') {
    if (!checker.isArrayType(member)) return void problems.push(`${path}: the server sends an array, the type is ${checker.typeToString(type)}`);
    compare(name, checker.getTypeArguments(member as ts.TypeReference)[0], shape.items!, `${path}[]`, problems);
    return;
  }
  if (shape.kind === 'map') {
    const value = checker.getIndexTypeOfType(member, ts.IndexKind.String);
    if (!value) return void problems.push(`${path}: the server sends a map, the type is ${checker.typeToString(type)}`);
    compare(name, value, shape.values!, `${path}{}`, problems);
    return;
  }
  if (has(member, ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike) || checker.isArrayType(member)) {
    return void problems.push(`${path}: the server sends an object, the type is ${checker.typeToString(type)}`);
  }
  for (const property of checker.getPropertiesOfType(member)) {
    const here = `${path}.${property.name}`;
    const sent = shape.fields![property.name];
    const optional = (property.flags & ts.SymbolFlags.Optional) !== 0;
    if (!sent) {
      if (!(optional && NOT_SENT.has(`${name}:${here}`))) problems.push(`${here}: the type declares it, the server does not send it`);
      continue;
    }
    if (!sent.required && !optional) problems.push(`${here}: the server leaves it out at times, the type requires it`);
    compare(name, checker.getTypeOfSymbol(property), sent.shape, here, problems);
  }
}

for (const [name, sources] of Object.entries(SNAPSHOTS)) {
  test(`the TypeScript types of ${name} match the JSON the server sends (FUNC-06)`, () => {
    const snapshot = JSON.parse(readFileSync(resolve(root, 'tests/contract', `${name}.json`), 'utf8')) as { endpoint: string; shape: Shape };
    const types = sources.flatMap(source => ('type' in source ? [declared(...source.type)] : calls(source.call)));
    assert.ok(types.length > 0, `no type found for ${snapshot.endpoint}`);
    const problems: string[] = [];
    for (const type of types) compare(name, type, snapshot.shape, '', problems);
    assert.deepEqual(problems, [], `${snapshot.endpoint}\n${problems.join('\n')}`);
  });
}
