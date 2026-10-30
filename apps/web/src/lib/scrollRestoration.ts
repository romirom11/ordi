import { useLayoutEffect, useRef, type RefObject } from 'react';

type Position = { path: number[]; top: number; left: number };

/** Retain each in-app tab's page and nested-pane positions across navigation. */
export function useScrollRestoration(rootRef: RefObject<HTMLElement | null>, key: string) {
  const pages = useRef(new Map<string, Map<string, Position>>());
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const saved = pages.current.get(key) ?? new Map<string, Position>();
    pages.current.delete(key);
    pages.current.set(key, saved);
    if (pages.current.size > 100) pages.current.delete(pages.current.keys().next().value!);
    let restoring = true;
    const restore = () => {
      if (!restoring) return;
      for (const position of saved.values()) {
        let element: Element | undefined = root;
        for (const index of position.path) element = element?.children[index];
        if (element instanceof HTMLElement) {
          element.scrollTop = position.top;
          element.scrollLeft = position.left;
        }
      }
    };
    if (!saved.size) { root.scrollTop = 0; root.scrollLeft = 0; }
    restore();
    const observer = new MutationObserver(restore);
    observer.observe(root, { subtree: true, childList: true });
    const stopRestoring = () => { restoring = false; observer.disconnect(); };
    const timer = window.setTimeout(stopRestoring, 2000);
    const remember = (element: HTMLElement) => {
      const path: number[] = [];
      let node: Element = element;
      while (node !== root && node.parentElement) {
        path.unshift(Array.from(node.parentElement.children).indexOf(node));
        node = node.parentElement;
      }
      if (node === root) saved.set(path.join('.'), { path, top: element.scrollTop, left: element.scrollLeft });
    };
    const save = (event: Event) => {
      if (!restoring && event.target instanceof HTMLElement) remember(event.target);
    };
    const interrupt = () => {
      if (!restoring) return;
      stopRestoring();
      // Focus/scrollIntoView may have scrolled a pane during its initial load.
      // Retain that visible position even if the next wheel hits its boundary.
      for (const element of [root, ...root.querySelectorAll<HTMLElement>('*')]) {
        if (element.scrollTop || element.scrollLeft) remember(element);
      }
    };
    root.addEventListener('scroll', save, true);
    for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.addEventListener(event, interrupt, { passive: true, capture: true });
    return () => {
      stopRestoring();
      clearTimeout(timer);
      root.removeEventListener('scroll', save, true);
      for (const event of ['wheel', 'touchstart', 'pointerdown', 'keydown']) root.removeEventListener(event, interrupt, true);
    };
  }, [key, rootRef]);
}
