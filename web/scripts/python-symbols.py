"""Read source from stdin; inspect Python syntax without importing/executing it."""
import ast
import json
import sys

source = sys.stdin.read()
tree = ast.parse(source)
lines = source.splitlines(keepends=True)
symbols = []


def visit(node, scope=()):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
        name = (*scope, node.name)
        symbols.append({
            'name': '.'.join(name), 'startLine': node.lineno,
            'endLine': node.end_lineno,
            'params': [ast.unparse(arg) for arg in node.args.posonlyargs + node.args.args]
                      + (['*' + ast.unparse(node.args.vararg)] if node.args.vararg else [])
                      + [ast.unparse(arg) for arg in node.args.kwonlyargs]
                      + (['**' + ast.unparse(node.args.kwarg)] if node.args.kwarg else []),
            'code': ''.join(lines[node.lineno - 1:node.end_lineno]).rstrip('\n'),
        })
        scope = name
    elif isinstance(node, ast.ClassDef):
        scope = (*scope, node.name)
    for child in ast.iter_child_nodes(node):
        visit(child, scope)


visit(tree)
json.dump(symbols, sys.stdout, ensure_ascii=False)
