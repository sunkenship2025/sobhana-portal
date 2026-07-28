import { useEffect, useState } from "react";

/**
 * Returns `value`, updated only after it's been stable for `delayMs`. Used to
 * avoid firing a server request on every keystroke for search-driven fetches
 * (server-side-paginated worklists, where each keystroke would otherwise be
 * a new page-1 network round trip).
 */
export function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
