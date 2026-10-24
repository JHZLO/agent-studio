import korean from './locales/ko.js';
let language = 'en';
export const locale = () => language === 'ko' ? 'ko-KR' : 'en-US';
export function setLanguage(value) {
  language = value === 'ko' ? 'ko' : 'en';
  if (typeof document !== 'undefined') document.documentElement.lang = language;
}
const slot = index => `\uE000${index}\uE001`;
function translate(source) {
  if (language !== 'ko') return source;
  const indices = [];
  const key = source.trim().replace(/\uE000(\d+)\uE001/g, (_, index) => `{${indices.push(index) - 1}}`);
  const value = Object.hasOwn(korean, key) ? korean[key] : undefined;
  if (value === undefined) return source;
  return source.replace(source.trim(), value.replace(/\{(\d+)\}/g, (match, index) => indices[index] === undefined ? match : slot(indices[index])));
}
function template(strings, values, markup) {
  const source = strings.reduce((text, part, index) => text + (index ? slot(index - 1) : '') + part, '');
  const translated = markup ? source.replace(/<[^>]*>|[^<]+/g, part => part.startsWith('<')
    ? part.replace(/\b(aria-label|aria-description|title|placeholder|alt)="([^"]*)"/g, (_, name, value) => `${name}="${translate(value)}"`)
    : translate(part)) : translate(source);
  return translated.replace(/\uE000(\d+)\uE001/g, (_, index) => String(values[index] ?? ''));
}
export function t(source, ...values) {
  return Array.isArray(source) ? template(source, values, false) : translate(String(source ?? ''));
}
// Translate literal markup before inserting names, instructions, or provider output.
export function html(strings, ...values) { return template(strings, values, true); }
export function attrs(strings, ...values) {
  const parts = [...strings]; parts[0] = '<x ' + parts[0]; parts[parts.length - 1] += '>';
  return template(parts, values, true).slice(3, -1);
}
