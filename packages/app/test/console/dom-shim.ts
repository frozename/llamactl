// packages/app/test/console/dom-shim.ts
// Issue #410 P5a-3d — a minimal DOM for react-dom/client under Bun
// (no happy-dom/jsdom in this repo): enough Node/Element/Document/Window
// surface to mount and unmount host trees (element creation, child-list
// mutation, attributes, style, textContent, querySelectorAll by
// data-testid) so effects actually run against real host instances.
// installDomShim() swaps in window/document/IS_REACT_ACT_ENVIRONMENT and
// uninstall() restores exactly what it replaced, cancelling the rAF
// timers it may have scheduled — no globals leak between tests.

const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const TEST_ID_ATTRIBUTE = "data-testid";
const TEST_ID_SELECTOR = /^\[data-testid=(?:"([^"]*)"|'([^']*)'|([^\]\s]+))\]$/;

interface ShimListenerTarget {
  addEventListener: (_type: string, _listener: unknown, _options?: unknown) => void;
  removeEventListener: (_type: string, _listener: unknown, _options?: unknown) => void;
}

interface ShimTextNodeLike extends ShimListenerTarget {
  nodeType: 3;
  nodeName: string;
  nodeValue: string;
  parentNode: ShimContainerLike | null;
  ownerDocument: ShimDocumentLike;
  textContent: string;
}

interface ShimCommentLike extends ShimListenerTarget {
  nodeType: 8;
  nodeName: string;
  data: string;
  parentNode: ShimContainerLike | null;
  ownerDocument: ShimDocumentLike;
  textContent: string;
}

interface ShimElementLike extends ShimListenerTarget {
  nodeType: 1;
  nodeName: string;
  tagName: string;
  namespaceURI: string;
  parentNode: ShimContainerLike | null;
  ownerDocument: ShimDocumentLike;
  childNodes: ShimNodeLike[];
  style: Record<string, unknown>;
  readonly firstChild: ShimNodeLike | null;
  readonly lastChild: ShimNodeLike | null;
  readonly nextSibling: ShimNodeLike | null;
  readonly previousSibling: ShimNodeLike | null;
  readonly options: ShimElementLike[];
  textContent: string;
  appendChild: (_child: ShimNodeLike) => ShimNodeLike;
  insertBefore: (_child: ShimNodeLike, _reference: ShimNodeLike | null) => ShimNodeLike;
  removeChild: (_child: ShimNodeLike) => ShimNodeLike;
  setAttribute: (_name: string, _value: string) => void;
  getAttribute: (_name: string) => string | null;
  removeAttribute: (_name: string) => void;
  hasAttribute: (_name: string) => boolean;
  contains: (_other: ShimNodeLike | null) => boolean;
  querySelectorAll: (_selector: string) => ShimElementLike[];
}

interface ShimDocumentLike extends ShimListenerTarget {
  nodeType: 9;
  nodeName: string;
  defaultView: ShimWindowLike;
  documentElement: ShimElementLike;
  body: ShimElementLike;
  childNodes: ShimNodeLike[];
  activeElement: ShimElementLike | null;
  visibilityState: string;
  createElement: (_tagName: string) => ShimElementLike;
  createElementNS: (_namespace: string, _tagName: string) => ShimElementLike;
  createTextNode: (_text: string) => ShimTextNodeLike;
  createComment: (_data: string) => ShimCommentLike;
}

interface ShimWindowLike extends ShimListenerTarget {
  document: ShimDocumentLike;
  HTMLIFrameElement: unknown;
  requestAnimationFrame: (_callback: () => void) => number;
  cancelAnimationFrame: (_handle: number) => void;
  cancelPendingFrames: () => void;
}

type ShimNodeLike = ShimCommentLike | ShimElementLike | ShimTextNodeLike;
type ShimContainerLike = ShimDocumentLike | ShimElementLike;

function listenerNoops(): ShimListenerTarget {
  return {
    addEventListener: (): undefined => undefined,
    removeEventListener: (): undefined => undefined,
  };
}

function detach(node: ShimNodeLike): void {
  const parent = node.parentNode;
  if (parent === null) {
    return;
  }
  const at = parent.childNodes.indexOf(node);
  if (at !== -1) {
    parent.childNodes.splice(at, 1);
  }
  node.parentNode = null;
}

function siblingAt(node: ShimNodeLike, offset: number): ShimNodeLike | null {
  const parent = node.parentNode;
  if (parent === null) {
    return null;
  }
  const at = parent.childNodes.indexOf(node);
  if (at === -1) {
    return null;
  }
  return parent.childNodes[at + offset] ?? null;
}

function collectText(node: ShimNodeLike): string {
  if (node.nodeType === 3) {
    return node.nodeValue;
  }
  if (node.nodeType === 1) {
    let text = "";
    for (const child of node.childNodes) {
      text += collectText(child);
    }
    return text;
  }
  return "";
}

function nodeContains(parent: ShimElementLike, other: ShimNodeLike | null): boolean {
  if (other === null) {
    return false;
  }
  for (const child of parent.childNodes) {
    if (child === other) {
      return true;
    }
    if (child.nodeType === 1 && nodeContains(child, other)) {
      return true;
    }
  }
  return false;
}

function collectByTestId(
  root: ShimElementLike,
  testId: string,
  out: ShimElementLike[],
): ShimElementLike[] {
  for (const child of root.childNodes) {
    if (child.nodeType !== 1) {
      continue;
    }
    if (child.getAttribute(TEST_ID_ATTRIBUTE) === testId) {
      out.push(child);
    }
    collectByTestId(child, testId, out);
  }
  return out;
}

function parseTestIdSelector(selector: string): string {
  const match = TEST_ID_SELECTOR.exec(selector);
  if (match === null) {
    throw new Error(`dom-shim: unsupported selector "${selector}"`);
  }
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function isOptionElement(node: ShimNodeLike): node is ShimElementLike {
  return node.nodeType === 1 && node.tagName === "OPTION";
}

function makeTextNode(text: string, ownerDocument: ShimDocumentLike): ShimTextNodeLike {
  const node: ShimTextNodeLike = {
    ...listenerNoops(),
    nodeType: 3,
    nodeName: "#text",
    nodeValue: text,
    parentNode: null,
    ownerDocument,
    get textContent(): string {
      return node.nodeValue;
    },
    set textContent(value: string) {
      node.nodeValue = value;
    },
  };
  return node;
}

function makeComment(data: string, ownerDocument: ShimDocumentLike): ShimCommentLike {
  const node: ShimCommentLike = {
    ...listenerNoops(),
    nodeType: 8,
    nodeName: "#comment",
    data,
    parentNode: null,
    ownerDocument,
    get textContent(): string {
      return "";
    },
    set textContent(_value: string) {
      // Comments carry no text content; assignment is a no-op.
    },
  };
  return node;
}

function makeElement(tagName: string, ownerDocument: ShimDocumentLike): ShimElementLike {
  const upper = tagName.toUpperCase();
  const attributes = new Map<string, string>();
  const node: ShimElementLike = {
    ...listenerNoops(),
    nodeType: 1,
    nodeName: upper,
    tagName: upper,
    namespaceURI: HTML_NAMESPACE,
    parentNode: null,
    ownerDocument,
    childNodes: [],
    style: {},
    get firstChild(): ShimNodeLike | null {
      return node.childNodes[0] ?? null;
    },
    get lastChild(): ShimNodeLike | null {
      return node.childNodes.at(-1) ?? null;
    },
    get nextSibling(): ShimNodeLike | null {
      return siblingAt(node, 1);
    },
    get previousSibling(): ShimNodeLike | null {
      return siblingAt(node, -1);
    },
    get options(): ShimElementLike[] {
      return node.childNodes.filter(isOptionElement);
    },
    get textContent(): string {
      return collectText(node);
    },
    set textContent(value: string) {
      for (const child of [...node.childNodes]) {
        node.removeChild(child);
      }
      if (value !== "") {
        node.appendChild(makeTextNode(value, ownerDocument));
      }
    },
    appendChild(child: ShimNodeLike): ShimNodeLike {
      detach(child);
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    insertBefore(child: ShimNodeLike, reference: ShimNodeLike | null): ShimNodeLike {
      if (reference === null) {
        return node.appendChild(child);
      }
      const at = node.childNodes.indexOf(reference);
      if (at === -1) {
        throw new Error("dom-shim: insertBefore reference is not a child of this node");
      }
      detach(child);
      child.parentNode = node;
      node.childNodes.splice(at, 0, child);
      return child;
    },
    removeChild(child: ShimNodeLike): ShimNodeLike {
      const at = node.childNodes.indexOf(child);
      if (at !== -1) {
        node.childNodes.splice(at, 1);
        child.parentNode = null;
      }
      return child;
    },
    setAttribute(name: string, value: string): void {
      attributes.set(name, value);
    },
    getAttribute(name: string): string | null {
      return attributes.get(name) ?? null;
    },
    removeAttribute(name: string): void {
      attributes.delete(name);
    },
    hasAttribute(name: string): boolean {
      return attributes.has(name);
    },
    contains(other: ShimNodeLike | null): boolean {
      return nodeContains(node, other);
    },
    querySelectorAll(selector: string): ShimElementLike[] {
      return collectByTestId(node, parseTestIdSelector(selector), []);
    },
  };
  return node;
}

function makeWindow(): ShimWindowLike {
  const frames = new Map<number, ReturnType<typeof setTimeout>>();
  let nextHandle = 1;
  return {
    ...listenerNoops(),
    document: undefined as unknown as ShimDocumentLike,
    HTMLIFrameElement: class ShimIFrame {
      readonly shim = true;
    },
    requestAnimationFrame: (callback: () => void): number => {
      const handle = nextHandle;
      nextHandle += 1;
      const timer = setTimeout(() => {
        frames.delete(handle);
        callback();
      }, 16);
      frames.set(handle, timer);
      return handle;
    },
    cancelAnimationFrame: (handle: number): void => {
      const timer = frames.get(handle);
      if (timer !== undefined) {
        clearTimeout(timer);
        frames.delete(handle);
      }
    },
    cancelPendingFrames: (): void => {
      for (const timer of frames.values()) {
        clearTimeout(timer);
      }
      frames.clear();
    },
  };
}

function makeDocument(win: ShimWindowLike): ShimDocumentLike {
  const doc: ShimDocumentLike = {
    ...listenerNoops(),
    nodeType: 9,
    nodeName: "#document",
    defaultView: win,
    documentElement: undefined as unknown as ShimElementLike,
    body: undefined as unknown as ShimElementLike,
    childNodes: [],
    activeElement: null,
    visibilityState: "visible",
    createElement: (tagName: string): ShimElementLike => makeElement(tagName, doc),
    createElementNS: (namespace: string, tagName: string): ShimElementLike => {
      const element = makeElement(tagName, doc);
      element.namespaceURI = namespace;
      return element;
    },
    createTextNode: (text: string): ShimTextNodeLike => makeTextNode(text, doc),
    createComment: (data: string): ShimCommentLike => makeComment(data, doc),
  };
  doc.documentElement = makeElement("html", doc);
  doc.body = makeElement("body", doc);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

export interface DomShim {
  readonly document: Document;
  readonly window: Window;
  uninstall: () => void;
}

export function installDomShim(): DomShim {
  const win = makeWindow();
  const doc = makeDocument(win);
  win.document = doc;

  const globals = globalThis as Record<string, unknown>;
  const hadWindow = "window" in globals;
  const hadDocument = "document" in globals;
  const hadActEnvironment = "IS_REACT_ACT_ENVIRONMENT" in globals;
  const previousWindow = globals["window"];
  const previousDocument = globals["document"];
  const previousActEnvironment = globals["IS_REACT_ACT_ENVIRONMENT"];

  globals["window"] = win;
  globals["document"] = doc;
  globals["IS_REACT_ACT_ENVIRONMENT"] = true;

  return {
    document: doc as unknown as Document,
    window: win as unknown as Window,
    uninstall(): void {
      win.cancelPendingFrames();
      if (hadWindow) {
        globals["window"] = previousWindow;
      } else {
        delete globals["window"];
      }
      if (hadDocument) {
        globals["document"] = previousDocument;
      } else {
        delete globals["document"];
      }
      if (hadActEnvironment) {
        globals["IS_REACT_ACT_ENVIRONMENT"] = previousActEnvironment;
      } else {
        delete globals["IS_REACT_ACT_ENVIRONMENT"];
      }
    },
  };
}
