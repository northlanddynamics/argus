// Minimal stand-in for the Design canvas runtime, used only to render the
// wireframe sources in ../src to static PNGs. Supports what the sources use:
// <helmet>, {{path}} holes in text and attributes, <sc-for>, <sc-if> (which
// render.mjs rewrites to <template data-sc> so tables parse), and a
// DCLogic class whose renderVals() supplies the data. Event handlers are ignored.
(function () {
  window.DCLogic = class DCLogic {
    constructor(props) { this.props = props || {}; this.state = {}; }
    setState() {}
    forceUpdate() {}
  };

  function lookup(scope, path) {
    path = path.trim();
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    return path.split('.').reduce((v, k) => (v == null ? undefined : v[k]), scope);
  }

  function interp(str, scope) {
    return str.replace(/\{\{([^}]+)\}\}/g, (_, p) => {
      const v = lookup(scope, p);
      return v == null ? '' : String(v);
    });
  }

  function render(node, scope, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      out.appendChild(document.createTextNode(interp(node.nodeValue, scope)));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    let tag = node.tagName.toLowerCase();
    if (tag === 'template' && node.dataset.sc) tag = 'sc-' + node.dataset.sc;
    const kids = (tag.startsWith('sc-') && node.content) ? node.content.childNodes : node.childNodes;
    if (tag === 'sc-for') {
      const list = lookup(scope, node.getAttribute('list').replace(/[{}]/g, '')) || [];
      const as = node.getAttribute('as') || 'item';
      list.forEach((item, i) => {
        const s = Object.assign(Object.create(scope), { [as]: item, $index: i });
        kids.forEach((c) => render(c, s, out));
      });
      return;
    }
    if (tag === 'sc-if') {
      if (lookup(scope, node.getAttribute('value').replace(/[{}]/g, ''))) {
        kids.forEach((c) => render(c, scope, out));
      }
      return;
    }
    const el = document.createElement(node.tagName);
    for (const a of node.attributes) {
      if (/^on[A-Z]/.test(a.name) || a.name.startsWith('hint-')) continue;
      const whole = a.value.match(/^\{\{([^}]+)\}\}$/);
      if (whole) {
        const v = lookup(scope, whole[1]);
        if (v === false || v == null) continue;
        el.setAttribute(a.name, v === true ? '' : String(v));
      } else {
        el.setAttribute(a.name, interp(a.value, scope));
      }
    }
    const src = tag === 'template' ? node.content : node;
    src.childNodes.forEach((c) => render(c, scope, el));
    out.appendChild(el);
  }

  document.addEventListener('DOMContentLoaded', () => {
    const host = document.querySelector('x-dc');
    const script = document.querySelector('script[data-dc-script]');
    // eslint-disable-next-line no-new-func
    const Component = new Function(script.textContent + '\nreturn Component;')();
    const vals = new Component({}).renderVals() || {};

    const helmet = host.querySelector('helmet');
    if (helmet) {
      [...helmet.children].forEach((c) => document.head.appendChild(c.cloneNode(true)));
      helmet.remove();
    }
    const frag = document.createDocumentFragment();
    host.childNodes.forEach((c) => render(c, vals, frag));
    host.replaceWith(frag);
    document.documentElement.setAttribute('data-rendered', '1');
  });
})();
