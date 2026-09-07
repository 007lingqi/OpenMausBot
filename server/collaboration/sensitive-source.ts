import ts from "typescript";
import { redactSensitiveText } from "./sensitive-text.ts";

const HIDDEN = "[敏感信息已隐藏]";
const LIMIT = 32000;
const credentialName = (name: string) =>
  /(?:password|passwd|secret|credential|token|apikey|密码|密钥|令牌|凭证)/iu.test(name.replace(/[_\s-]/gu, ""));
type Span = { start: number; end: number; text: string };

// Parse only. Never resolve imports, evaluate constant expressions, or run candidate code.
function parse(source: string, file: string): ts.SourceFile {
  if (!/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(file) || !source.length ||
    Buffer.byteLength(source) > LIMIT || source.includes("\0")) throw new Error("sensitive_source_invalid");
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  if ((parsed as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length)
    throw new Error("sensitive_source_parse_failed");
  return parsed;
}

/** Small, syntactic key decoder, not a JavaScript evaluator. Unknown computed keys fail conservatively. */
function staticKey(node: ts.Node): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticKey(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticKey(node.left), right = staticKey(node.right);
    if (left !== undefined && right !== undefined) return left + right;
  }
  return undefined;
}
function sensitiveName(node: ts.Node): boolean {
  if (ts.isComputedPropertyName(node) || ts.isElementAccessExpression(node)) {
    const expression = ts.isComputedPropertyName(node) ? node.expression : node.argumentExpression;
    const key = staticKey(expression);
    return key === undefined || credentialName(key);
  }
  if (ts.isPropertyAccessExpression(node)) return sensitiveName(node.name);
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) return sensitiveName(node.expression);
  const key = ts.isIdentifier(node) || ts.isPrivateIdentifier(node) ? node.text : staticKey(node);
  return key !== undefined && credentialName(key);
}

/** Bounded source view for models, not executable output or a universal secret detector. */
export function redactSensitiveSource(source: string, file = "source.ts"): string {
  try {
    const tree = parse(source, file);
    const spans: Span[] = [];
    const replace = (start: number, end: number, text: string) => {
      const newlines = source.slice(start, end).match(/\r\n|[\r\n\u2028\u2029]/gu)?.join("") ?? "";
      spans.push({ start, end, text: text + (newlines ? `/*${newlines}*/` : "") });
    };
    const hide = (node: ts.Node) => replace(node.getStart(tree), node.end, JSON.stringify(HIDDEN));
    const literalNeedsMask = (text: string) => redactSensitiveText(text) !== text;
    const templateSensitive = (node: ts.TemplateLiteral): boolean => {
      if (ts.isNoSubstitutionTemplateLiteral(node)) return literalNeedsMask(node.text);
      // Include substitutions' source only for conservative detection; never evaluate them.
      return literalNeedsMask(node.getText(tree)) || literalNeedsMask(node.head.text) ||
        node.templateSpans.some(span => literalNeedsMask(span.literal.text));
    };
    const visit = (node: ts.Node, sensitive = false): void => {
      if (ts.isJsxAttribute(node)) {
        if (node.initializer) visit(node.initializer, sensitive || credentialName(node.name.getText(tree)));
        return;
      }
      if (ts.isJsxText(node)) {
        if (sensitive || literalNeedsMask(node.text)) {
          // JSX text is not a JS expression: preserve line breaks as text,
          // without inserting quotes or executable expression delimiters.
          const raw = source.slice(node.pos, node.end);
          spans.push({ start: node.pos, end: node.end, text: HIDDEN + (raw.match(/\r\n|[\r\n\u2028\u2029]/gu)?.join("") ?? "") });
        }
        return;
      }
      if (ts.isTaggedTemplateExpression(node) && (sensitive || sensitiveName(node.tag) || templateSensitive(node.template))) {
        hide(node); return;
      }
      if (ts.isTemplateExpression(node) && (sensitive || templateSensitive(node))) { hide(node); return; }
      if (ts.isStringLiteralLike(node)) {
        if ((sensitive && node.text.length > 0) || literalNeedsMask(node.text)) hide(node);
        return;
      }
      if ((ts.isNumericLiteral(node) || ts.isBigIntLiteral(node) || ts.isRegularExpressionLiteral(node)) &&
        (sensitive || literalNeedsMask(node.getText(tree)))) { hide(node); return; }
      if (ts.isPropertySignature(node) && node.type) {
        ts.forEachChild(node, child => visit(child, sensitive || (child === node.type && sensitiveName(node.name))));
        return;
      }
      if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node) ||
        ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) && node.initializer) {
        const namedSensitive = sensitiveName(node.name) ||
          (ts.isBindingElement(node) && !!node.propertyName && sensitiveName(node.propertyName));
        ts.forEachChild(node, child => visit(child, sensitive || (child === node.initializer && namedSensitive)));
        return;
      }
      if (ts.isBinaryExpression(node)) {
        visit(node.left, sensitive || sensitiveName(node.right));
        visit(node.right, sensitive || sensitiveName(node.left));
        return;
      }
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        ts.forEachChild(node, child => visit(child, sensitive ||
          (!!node.arguments?.includes(child as ts.Expression) && sensitiveName(node.expression))));
        return;
      }
      ts.forEachChild(node, child => visit(child, sensitive));
    };
    visit(tree);

    // Token trivia ranges avoid interpreting comment-like text inside strings, regexes or templates.
    const comments = new Set<number>();
    const checkComments = (position: number) => {
      for (const range of [...ts.getLeadingCommentRanges(source, position) ?? [], ...ts.getTrailingCommentRanges(source, position) ?? []]) {
        if (comments.has(range.pos)) continue;
        comments.add(range.pos);
        if (literalNeedsMask(source.slice(range.pos, range.end))) {
          replace(range.pos, range.end, `/*${HIDDEN}*/`);
        }
      }
    };
    const tokens = (node: ts.Node): void => {
      checkComments(node.pos); checkComments(node.end);
      for (const child of node.getChildren(tree)) tokens(child);
    };
    tokens(tree);
    spans.sort((a, b) => a.start - b.start || b.end - a.end);
    let output = "", cursor = 0;
    for (const span of spans) {
      if (span.start < cursor) continue; // A masked template/expression already covers this comment.
      output += source.slice(cursor, span.start) + span.text;
      cursor = span.end;
    }
    output += source.slice(cursor);
    parse(output, file);
    return output;
  } catch {
    // Parser diagnostics and nested failures can contain source values; never propagate them.
    throw new Error("sensitive_source_unavailable");
  }
}
