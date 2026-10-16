import ts from 'typescript';
import { posix } from 'node:path';
import { policy, BuildRejected } from './policy.mjs';
export function inspectImports(files) {
  for (const [name, content] of Object.entries(files)) {
    if (!name.endsWith('.tsx')) continue;
    const ast = ts.createSourceFile(name, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    if (ast.parseDiagnostics.length) throw new BuildRejected('TSX parse error', 'SYNTAX_ERROR');
    if (ast.referencedFiles.length || ast.typeReferenceDirectives.length) throw new BuildRejected('External type references forbidden', 'IMPORT_REJECTED');
    function specifier(value) {
      if (typeof value !== 'string') throw new BuildRejected('Nonliteral module specifier forbidden', 'IMPORT_REJECTED');
      if (value.startsWith('.')) {
        if (value.includes('\\') || value.split('/').includes('..')) throw new BuildRejected('Traversal import forbidden', 'IMPORT_REJECTED');
        const path = posix.join(posix.dirname(name), value);
        if (![path, `${path}.tsx`].some(candidate => Object.hasOwn(files, candidate))) throw new BuildRejected('Unknown source import', 'IMPORT_REJECTED');
      } else if (!policy.allowedBareImports.includes(value)) throw new BuildRejected(`Dependency forbidden: ${value}`, 'IMPORT_REJECTED');
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) specifier(node.moduleSpecifier.text);
      if (ts.isImportTypeNode(node)) specifier(node.argument.literal?.text);
      if (ts.isImportEqualsDeclaration(node)) throw new BuildRejected('import=require forbidden', 'IMPORT_REJECTED');
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require')) throw new BuildRejected('Dynamic dependency resolution forbidden', 'IMPORT_REJECTED');
      ts.forEachChild(node, visit);
    }
    visit(ast);
  }
}
