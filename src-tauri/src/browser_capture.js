// Evaluated only by trusted Rust in WebKit's isolated client world. No page IPC,
// polling timer, network interception or script supplied by a webpage is used.
(action) => {
  const key = '__specrailsNativeSelectionV1';
  let state = globalThis[key];
  if (!state) {
    let enabled = false;
    let target = null;
    let selected = false;
    let overlay = null;
    let hitLayer = null;
    const escape = (value) => CSS.escape(value);
    const selectorFor = (element) => {
      if (element.id) return `#${escape(element.id)}`;
      const parts = [];
      for (let current = element; current && parts.length < 12; current = current.parentElement) {
        if (current.id) { parts.unshift(`#${escape(current.id)}`); break; }
        let part = current.localName;
        if (!part) break;
        const parent = current.parentElement;
        if (parent) {
          const siblings = [...parent.children].filter((child) => child.localName === current.localName);
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
      }
      return parts.join(' > ').slice(0, 2048);
    };
    const measure = () => {
      if (!target?.isConnected) return null;
      const rect = target.getBoundingClientRect();
      if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || rect.width <= 0 || rect.height <= 0) return null;
      return {
        selector: selectorFor(target),
        tagName: target.localName,
        text: (target.innerText || target.textContent || '').trim().slice(0, 2000),
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      };
    };
    const syncHitLayer = () => {
      if (!enabled) {
        if (hitLayer) {
          if (typeof hitLayer.hidePopover === 'function' && hitLayer.matches(':popover-open')) hitLayer.hidePopover();
          hitLayer.hidden = true;
        }
        return;
      }
      if (!hitLayer?.isConnected) {
        hitLayer = document.createElement('div');
        hitLayer.setAttribute('data-specrails-native-hit-layer', '');
        // A separate transparent surface catches input BEFORE it enters an
        // iframe's document, whose events never bubble to this window. Use the
        // top layer when supported so an open page dialog cannot cover it.
        hitLayer.setAttribute('popover', 'manual');
        hitLayer.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;pointer-events:auto;z-index:2147483647;cursor:crosshair;';
        document.documentElement.appendChild(hitLayer);
      }
      hitLayer.hidden = false;
      if (hitLayer.hasAttribute('popover') && typeof hitLayer.showPopover === 'function' && !hitLayer.matches(':popover-open')) {
        try { hitLayer.showPopover(); } catch { /* ordinary fixed-layer fallback */ }
        if (!hitLayer.matches(':popover-open')) hitLayer.removeAttribute('popover');
      }
    };
    const paint = () => {
      syncHitLayer();
      const selection = measure();
      if (!enabled || !selection) { if (overlay) overlay.hidden = true; return; }
      if (!overlay?.isConnected) {
        overlay = document.createElement('div');
        overlay.setAttribute('data-specrails-native-selection', '');
        overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #06b6d4;background:rgba(6,182,212,.09);border-radius:3px;';
        document.documentElement.appendChild(overlay);
      }
      overlay.hidden = false;
      const rect = selection.rect;
      Object.assign(overlay.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    const elementAtPoint = (x, y) => {
      // Temporarily remove only the transparent hit layer from hit-testing;
      // the highlight always has pointer-events:none. No input is dispatched
      // while it is disabled, so the underlying iframe never sees the click.
      if (hitLayer) hitLayer.style.pointerEvents = 'none';
      try {
        let element = document.elementFromPoint(x, y);
        for (let depth = 0; element?.shadowRoot && depth < 16; depth++) {
          const inner = element.shadowRoot.elementFromPoint?.(x, y);
          if (!inner || inner === element) break;
          element = inner;
        }
        return element;
      } finally { if (hitLayer) hitLayer.style.pointerEvents = 'auto'; }
    };
    const eventElement = (event) => {
      const element = event.composedPath().find((entry) => entry instanceof Element);
      return element && element !== hitLayer && element !== overlay ? element : elementAtPoint(event.clientX, event.clientY);
    };
    const onMove = (event) => {
      if (!enabled || selected) return;
      const element = eventElement(event);
      if (element && element !== overlay && element !== target) { target = element; paint(); }
    };
    const onDown = (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      target = eventElement(event);
      selected = false;
      paint();
    };
    const onClick = (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      target = eventElement(event) || target;
      selected = true;
      paint();
    };
    const preventClick = (event) => {
      if (!enabled) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onKey = (event) => {
      if (!enabled || event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      target = null;
      selected = false;
      paint();
    };
    state = {
      enable(value) {
        if (enabled === value) return;
        enabled = value;
        if (value) { target = null; selected = false; }
        const method = value ? 'addEventListener' : 'removeEventListener';
        window[method]('pointermove', onMove, true);
        window[method]('pointerdown', onDown, true);
        window[method]('mousedown', preventClick, true);
        window[method]('pointerup', preventClick, true);
        window[method]('mouseup', preventClick, true);
        window[method]('click', onClick, true);
        window[method]('keydown', onKey, true);
        window[method]('scroll', paint, true);
        window[method]('resize', paint, true);
        paint();
      },
      selection() { paint(); return selected ? measure() : null; },
      capture(selectionOnly) {
        const element = selected ? measure() : null;
        if (selectionOnly && !element) throw new Error('Select an element before capturing');
        // Remove the highlight before WebKit takes its snapshot. Keep the actual
        // Element, so a layout change is remeasured rather than using a stale rect.
        this.enable(false);
        return {
          url: location.href,
          title: document.title.slice(0, 4096),
          viewport: { width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio },
          element: selectionOnly ? element : null,
        };
      },
    };
    Object.defineProperty(globalThis, key, { value: state });
  }
  if (action === 'enable') { state.enable(true); return null; }
  if (action === 'disable') { state.enable(false); return null; }
  if (action === 'selection') return state.selection();
  if (action === 'capture-selection') return state.capture(true);
  if (action === 'capture-page') return state.capture(false);
  throw new Error('Unknown native capture action');
}
