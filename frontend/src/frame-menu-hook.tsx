import { Patch, afterPatch, findInReactTree, getReactRoot } from '@decky/ui';
import { Children, ComponentType, ReactNode, cloneElement, isValidElement } from 'react';

import Logger from './logger';

export const FRAME_DECKY_ROUTE = '/decky';

interface NativeRouteProps {
  route: string;
  label: string;
  icon: ReactNode;
  active: boolean;
}

interface FrameMenuRenderer {
  type: ComponentType;
}

interface MenuFiber {
  tag?: number;
  child?: MenuFiber;
  elementType?: unknown;
  type?: unknown;
  alternate?: MenuFiber;
  return?: MenuFiber;
  memoizedProps?: {
    frame?: unknown;
    autoCollapse?: boolean;
    variant?: unknown;
    route?: string;
    label?: string;
    icon?: ReactNode;
  };
  stateNode?: {
    _deckyForceRerender?: () => void;
    containerInfo?: {
      ownerDocument?: {
        title?: string;
      };
    };
  };
}

const isMenuRenderer = (value: unknown): value is FrameMenuRenderer =>
  typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'function';

const isRouteButton = (value: unknown): value is ComponentType<NativeRouteProps> => typeof value === 'function';

declare global {
  interface Window {
    __FRAME_MENU_HOOK_INSTANCE?: FrameMenuHook;
  }
}

class FrameMenuHook extends Logger {
  private patch?: Patch;
  private renderer?: FrameMenuRenderer;
  private retryTimer?: ReturnType<typeof setInterval>;
  private retries = 0;

  constructor() {
    super('FrameMenuHook');
    window.__FRAME_MENU_HOOK_INSTANCE?.deinit();
    window.__FRAME_MENU_HOOK_INSTANCE = this;
  }

  init(icon: ReactNode) {
    if (!('vrFrameStore' in window)) return;

    this.log('Waiting for the native Frame menu');
    if (this.tryPatch(icon) === 'waiting') {
      this.retryTimer = setInterval(() => {
        if (this.tryPatch(icon) !== 'waiting') {
          clearInterval(this.retryTimer);
          this.retryTimer = undefined;
        } else if (++this.retries === 30) {
          this.warn('Frame menu or its native route buttons are not ready; continuing to wait');
        }
      }, 1000);
    }
  }

  private tryPatch(icon: ReactNode): 'waiting' | 'patched' {
    const rootElement = document.getElementById('root');
    if (!rootElement) return 'waiting';
    const root = getReactRoot(rootElement);
    // Frame renders its visible menu into a separate VR window via a React portal.
    const portal: MenuFiber | undefined = findInReactTree(
      root,
      (node: MenuFiber) =>
        node.tag === 4 && !!node.stateNode?.containerInfo?.ownerDocument?.title?.includes('gamepadui.frame.menu.'),
    );
    if (!portal) return 'waiting';
    const menu: MenuFiber | undefined = findInReactTree(
      portal.child,
      (node: MenuFiber) =>
        !!node.memoizedProps?.frame &&
        typeof node.memoizedProps.autoCollapse === 'boolean' &&
        node.memoizedProps.variant !== undefined &&
        isMenuRenderer(node.elementType),
    );
    if (!menu || !isMenuRenderer(menu.elementType)) return 'waiting';

    const routeNode: MenuFiber | undefined = findInReactTree(
      menu,
      (node: MenuFiber) =>
        node.memoizedProps?.route === '/library/home' &&
        typeof node.memoizedProps.label === 'string' &&
        isRouteButton(node.elementType),
    );
    if (!routeNode || !isRouteButton(routeNode.elementType)) {
      return 'waiting';
    }

    const RouteButton: ComponentType<NativeRouteProps> = routeNode.elementType;
    this.renderer = menu.elementType;
    this.patch = afterPatch(this.renderer, 'type', (_, ret: unknown) => {
      if (!isValidElement<{ children?: ReactNode }>(ret)) {
        this.error('Native Frame menu returned an unexpected React tree');
        return ret;
      }
      return cloneElement(
        ret,
        {},
        ...Children.toArray(ret.props.children),
        <RouteButton
          key="decky-frame-entry"
          route={FRAME_DECKY_ROUTE}
          label="Decky"
          icon={icon}
          active={window.location.pathname === FRAME_DECKY_ROUTE}
        />,
      );
    });
    this.refreshMenu(menu);
    this.log('Added Decky to the native Frame menu');
    return 'patched';
  }

  private refreshMenu(menu: MenuFiber) {
    menu.type = this.renderer?.type;
    if (menu.alternate) menu.alternate.type = menu.type;

    // Use Decky's existing error-boundary rerender mechanism for already mounted menus.
    let ancestor: MenuFiber | undefined = menu;
    while (ancestor && !ancestor.stateNode?._deckyForceRerender) ancestor = ancestor.return;
    if (ancestor) ancestor.stateNode?._deckyForceRerender?.();
    else this.warn('Frame menu will show the updated entry on its next render');
  }

  deinit() {
    clearInterval(this.retryTimer);
    this.retryTimer = undefined;
    this.retries = 0;
    this.patch?.unpatch();
    this.patch = undefined;

    const rootElement = document.getElementById('root');
    if (rootElement && this.renderer) {
      const menu: MenuFiber | undefined = findInReactTree(
        getReactRoot(rootElement),
        (node: MenuFiber) => node.elementType === this.renderer,
      );
      if (menu) this.refreshMenu(menu);
    }
    this.renderer = undefined;
  }
}

export default FrameMenuHook;
