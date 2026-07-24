/** Runtime fallbacks for the oldest supported Android 7 WebViews.
 *
 * Vite's legacy bundle transpiles JavaScript syntax, but browser APIs are not
 * automatically supplied. Keep these tiny fallbacks ahead of UI construction
 * so a factory-era WebView does not fail before the title screen appears.
 */
export function installCompatibilityFallbacks() {
  const root = globalThis as typeof globalThis & {
    ResizeObserver?: typeof ResizeObserver;
    queueMicrotask?: (callback: VoidFunction) => void;
  };

  if (typeof root.queueMicrotask !== 'function') {
    root.queueMicrotask = (callback: VoidFunction) => {
      void Promise.resolve().then(callback);
    };
  }

  if (typeof root.ResizeObserver !== 'function') {
    class ResizeObserverFallback {
      private readonly elements = new Set<Element>();
      private scheduled = false;

      constructor(private readonly callback: ResizeObserverCallback) {
        addEventListener('resize', this.schedule);
      }

      observe(element: Element) {
        this.elements.add(element);
        this.schedule();
      }

      unobserve(element: Element) {
        this.elements.delete(element);
      }

      disconnect() {
        this.elements.clear();
        removeEventListener('resize', this.schedule);
      }

      private readonly schedule = () => {
        if (this.scheduled) return;
        this.scheduled = true;
        requestAnimationFrame(() => {
          this.scheduled = false;
          const entries = [...this.elements].filter(element => element.isConnected).map(element => ({
            target: element,
            contentRect: element.getBoundingClientRect(),
          })) as ResizeObserverEntry[];
          if (entries.length) this.callback(entries, this as unknown as ResizeObserver);
        });
      };
    }
    root.ResizeObserver = ResizeObserverFallback as unknown as typeof ResizeObserver;
  }

  if (globalThis.crypto && typeof globalThis.crypto.randomUUID !== 'function') {
    const randomUUID = () => {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    try {
      Object.defineProperty(globalThis.crypto, 'randomUUID', {
        configurable: true,
        value: randomUUID,
      });
    } catch {
      // Some WebViews expose Crypto as non-extensible. AccountService also
      // carries the same fallback, so failure here cannot block rewarded ads.
    }
  }
}
