// New verification: compare executable ASTs after erasing restored types.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import ts from 'typescript';

export async function checkRecoveredRegions(archiveRoot) {
  const entries = await import('node:fs/promises').then(fs => fs.readdir(resolve(archiveRoot, 'dist')));
  const bundle = await readFile(resolve(archiveRoot, 'dist', entries.find(name => /^app-.*\.mjs$/.test(name))), 'utf8');
  const aliases = new Map([['mediaType$1', 'mediaType']]);
  function normalized(node) {
    if (ts.isParenthesizedExpression(node)) return normalized(node.expression);
    if (ts.isVoidExpression(node) && ts.isNumericLiteral(node.expression) && Number(node.expression.text) === 0) return ['undefined'];
    if (ts.isIdentifier(node)) return node.text === 'undefined' ? ['undefined'] : ['identifier', aliases.get(node.text) ?? node.text];
    if (ts.isNumericLiteral(node)) return ['number', Number(node.text)];
    if (ts.isStringLiteral(node)) return ['string', node.text];
    if (ts.isRegularExpressionLiteral(node)) return ['regex', node.text];
    if (ts.isReturnStatement(node) && !node.expression) return [ts.SyntaxKind.ReturnStatement, ['undefined']];
    if (ts.isClassDeclaration(node)) return ['class', node.name.text, ...node.members.map(normalized)];
    if (ts.isVariableStatement(node) && node.declarationList.declarations.length === 1) {
      const declaration = node.declarationList.declarations[0];
      if (declaration.initializer && ts.isClassExpression(declaration.initializer)) return ['class', declaration.name.text, ...declaration.initializer.members.map(normalized)];
    }
    const children = [];
    ts.forEachChild(node, child => { if (![ts.SyntaxKind.ExportKeyword].includes(child.kind)) children.push(normalized(child)); });
    return [node.kind, ...(ts.isVariableDeclarationList(node) ? [node.flags & ts.NodeFlags.BlockScoped] : []), ...children];
  }
  function statements(code) {
    return ts.createSourceFile('region.js', code, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS).statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(normalized);
  }
  for (const name of ['direct-proxy', 'direct-acquisition', 'fetch-security', 'vendor/proxy-from-env']) {
    const marker = `//#region src/${name}.ts`;
    const start = bundle.indexOf(marker);
    assert.notEqual(start, -1, 'Missing accepted region: ' + name);
    const region = bundle.slice(start + marker.length, bundle.indexOf('//#endregion', start));
    const source = await readFile(resolve(import.meta.dirname, '../src', name + '.ts'), 'utf8');
    const erased = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, useDefineForClassFields: true } }).outputText;
    assert.deepEqual(statements(erased), statements(region), 'Executable region changed: ' + name);
  }
  console.log('Accepted next.7: all four recovered adapter/proxy regions have matching executable ASTs');
}
