// Dumps the Firefox chrome DOM tree to ~/chrome-dom.txt
// Paste into Browser Console (Ctrl+Shift+J)
//
// Tip: disable userChrome.css first (about:config →
// toolkit.legacyUserProfileCustomizations.stylesheets = false)
// to capture the raw structure.

function dumpTree(el, depth = 0) {
  if (!el || el.nodeType !== 1) return "";
  const indent = "  ".repeat(depth);
  const id = el.id ? `#${el.id}` : "";
  const cls = el.classList?.length ? `.${[...el.classList].join(".")}` : "";
  const tag = el.localName;
  const hidden = el.hidden ? " [hidden]" : "";
  const attrs = [];
  if (el.getAttribute("style")) attrs.push("style=...");
  if (el.getAttribute("hidden")) attrs.push("hidden");
  if (el.getAttribute("collapsed")) attrs.push("collapsed");
  const extra = attrs.length ? ` (${attrs.join(", ")})` : "";
  let out = `${indent}<${tag}${id}${cls}${hidden}${extra}>\n`;
  if (depth < 8 && tag !== "script" && tag !== "style") {
    for (const child of el.children) {
      out += dumpTree(child, depth + 1);
    }
  }
  return out;
}

const tree = dumpTree(document.documentElement);
const path = PathUtils.join(Services.dirsvc.get("Home", Ci.nsIFile).path, "chrome-dom.txt");
IOUtils.writeUTF8(path, tree);
console.log(`Dumped to ${path}`);
