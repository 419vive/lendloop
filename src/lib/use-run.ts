"use client";

import { useCallback, useState } from "react";
import { errorMessage } from "./format";

/**
 * Wraps an async action (usually a Convex mutation) with pending + error
 * state, so every button shows progress and server-side rejections
 * (e.g. RBAC "FORBIDDEN") surface as readable messages.
 */
export function useRun() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setPending(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(errorMessage(e));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: () => setError(null) };
}
