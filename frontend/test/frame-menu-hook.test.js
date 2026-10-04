import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/frame-menu-hook.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
}).outputText;

function createHarness({ frame = true, mounted = true, routeButton = true } = {}) {
  const logs = [];
  const timers = new Map();
  let nextTimer = 0;
  let rerenders = 0;
  const originalRender = () => ({ type: 'menu', props: { children: ['home', 'settings'] } });
  const renderer = { type: originalRender };
  const nativeButton = () => null;
  const routeNode = { elementType: nativeButton, memoizedProps: { route: '/library/home', label: 'Home' } };
  const menu = {
    elementType: renderer,
    type: originalRender,
    alternate: { type: originalRender },
    memoizedProps: { frame: {}, autoCollapse: true, variant: 'sidebar' },
    child: routeButton ? routeNode : undefined,
    return: { stateNode: { _deckyForceRerender: () => rerenders++ } },
  };
  const portal = {
    tag: 4,
    stateNode: { containerInfo: { ownerDocument: { title: 'SteamVR - valve.steam.gamepadui.frame.menu.1' } } },
    child: mounted ? menu : undefined,
  };
  const root = { child: portal };
  const window = { location: { pathname: '/decky' } };
  if (frame) window.vrFrameStore = {};
  const element = (type, props, key) => ({ type, props, key });
  const module = { exports: {} };
  const react = {
    Children: { toArray: (children) => (Array.isArray(children) ? [...children] : [children]) },
    cloneElement: (node, props, ...children) => ({
      ...node,
      props: { ...node.props, ...props, children },
    }),
    isValidElement: (node) => !!node?.type && !!node?.props,
  };
  const ui = {
    getReactRoot: () => root,
    findInReactTree: (node, predicate) => {
      if (!node) return undefined;
      if (predicate(node)) return node;
      return ui.findInReactTree(node.child, predicate) || ui.findInReactTree(node.sibling, predicate);
    },
    afterPatch: (object, property, handler) => {
      const original = object[property];
      object[property] = (...args) => handler(args, original(...args));
      return { unpatch: () => (object[property] = original) };
    },
  };
  class Logger {
    log(...args) {
      logs.push(['log', ...args]);
    }
    warn(...args) {
      logs.push(['warn', ...args]);
    }
    error(...args) {
      logs.push(['error', ...args]);
    }
  }
  runInNewContext(compiled, {
    exports: module.exports,
    require: (name) => {
      if (name === '@decky/ui') return ui;
      if (name === 'react') return react;
      if (name === 'react/jsx-runtime') return { jsx: element };
      if (name === './logger') return { default: Logger };
      throw new Error(`Unexpected import: ${name}`);
    },
    window,
    document: { getElementById: () => root },
    setInterval: (callback) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
  return {
    Hook: module.exports.default,
    logs,
    menu,
    nativeButton,
    originalRender,
    portal,
    renderer,
    root,
    timers,
    window,
    rerenders: () => rerenders,
  };
}

test('does not patch or poll on Deck/Machine without the VR Frame store', () => {
  const h = createHarness({ frame: false });
  new h.Hook().init('icon');
  assert.equal(h.renderer.type, h.originalRender);
  assert.equal(h.timers.size, 0);
});

test('adds a native route button without replacing existing menu entries', () => {
  const h = createHarness();
  new h.Hook().init('icon');
  const children = h.renderer.type().props.children;
  assert.equal(children[0], 'home');
  assert.equal(children[1], 'settings');
  assert.equal(children.length, 3);
  assert.equal(children[2].type, h.nativeButton);
  assert.equal(children[2].props.route, '/decky');
  assert.equal(children[2].props.label, 'Decky');
  assert.equal(children[2].props.icon, 'icon');
  assert.equal(children[2].props.active, true);
  assert.equal(h.menu.type, h.renderer.type);
  assert.equal(h.menu.alternate.type, h.renderer.type);
  assert.equal(h.rerenders(), 1);
  assert.equal(h.timers.size, 0);
});

test('waits for a mounted menu and stops polling after patching it', () => {
  const h = createHarness({ mounted: false });
  new h.Hook().init('icon');
  assert.equal(h.timers.size, 1);
  const retry = [...h.timers.values()][0];
  retry();
  assert.equal(h.renderer.type, h.originalRender);
  h.portal.child = h.menu;
  retry();
  assert.notEqual(h.renderer.type, h.originalRender);
  assert.equal(h.timers.size, 0);
});

test('waits for the native route button to mount instead of installing a broken entry', () => {
  const h = createHarness({ routeButton: false });
  new h.Hook().init('icon');
  assert.equal(h.renderer.type, h.originalRender);
  assert.equal(h.timers.size, 1);
  h.menu.child = { elementType: h.nativeButton, memoizedProps: { route: '/library/home', label: 'Home' } };
  [...h.timers.values()][0]();
  assert.notEqual(h.renderer.type, h.originalRender);
  assert.equal(h.timers.size, 0);
});

test('ignores matching outer wrappers outside the visible Frame portal', () => {
  const h = createHarness();
  const outerRenderer = { type: h.originalRender };
  h.root.child = {
    elementType: outerRenderer,
    memoizedProps: h.menu.memoizedProps,
    sibling: h.portal,
  };
  new h.Hook().init('icon');
  assert.equal(outerRenderer.type, h.originalRender);
  assert.notEqual(h.renderer.type, h.originalRender);
});

test('deinit restores the renderer and both mounted fibers', () => {
  const h = createHarness();
  const hook = new h.Hook();
  hook.init('icon');
  hook.deinit();
  hook.deinit();
  assert.equal(h.renderer.type, h.originalRender);
  assert.equal(h.menu.type, h.originalRender);
  assert.equal(h.menu.alternate.type, h.originalRender);
  assert.equal(h.rerenders(), 2);
});

test('deinit cancels a pending retry', () => {
  const h = createHarness({ mounted: false });
  const hook = new h.Hook();
  hook.init('icon');
  hook.deinit();
  assert.equal(h.timers.size, 0);
});

test('reinitialization removes the old hook rather than duplicating the entry', () => {
  const h = createHarness();
  new h.Hook().init('first');
  new h.Hook().init('second');
  const children = h.renderer.type().props.children;
  assert.equal(children.length, 3);
  assert.equal(children[2].props.icon, 'second');
});
