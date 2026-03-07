function createNoopStorage(): Storage {
  let length = 0;
  return {
    get length() {
      return length;
    },
    clear() {
      length = 0;
    },
    getItem() {
      return null;
    },
    key() {
      return null;
    },
    removeItem() {
      length = 0;
    },
    setItem() {
      length = 1;
    },
  };
}

function isStorageLike(value: unknown): value is Storage {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Storage).getItem === "function" &&
    typeof (value as Storage).setItem === "function" &&
    typeof (value as Storage).removeItem === "function" &&
    typeof (value as Storage).clear === "function" &&
    typeof (value as Storage).key === "function"
  );
}

function patchStorageCandidate(value: unknown): Storage | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Partial<Storage>;
  try {
    if (typeof candidate.getItem !== "function") {
      candidate.getItem = () => null;
    }
    if (typeof candidate.setItem !== "function") {
      candidate.setItem = () => undefined;
    }
    if (typeof candidate.removeItem !== "function") {
      candidate.removeItem = () => undefined;
    }
    if (typeof candidate.clear !== "function") {
      candidate.clear = () => undefined;
    }
    if (typeof candidate.key !== "function") {
      candidate.key = () => null;
    }
    if (typeof candidate.length !== "number") {
      Object.defineProperty(candidate, "length", {
        configurable: true,
        enumerable: true,
        get: () => 0,
      });
    }
  } catch {
    return null;
  }

  return isStorageLike(candidate) ? (candidate as Storage) : null;
}

const fallbackStorage = createNoopStorage();

export function getLocalStorage(): Storage {
  if (typeof globalThis === "undefined") {
    return fallbackStorage;
  }

  try {
    if (isStorageLike(globalThis.localStorage)) {
      return globalThis.localStorage;
    }

    const patchedStorage = patchStorageCandidate(globalThis.localStorage);
    if (patchedStorage) {
      return patchedStorage;
    }
  } catch {
    // Fall through to the fallback storage below.
  }

  try {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: fallbackStorage,
    });
  } catch {
    // Ignore assignment failures and return the fallback storage directly.
  }

  return isStorageLike(globalThis.localStorage) ? globalThis.localStorage : fallbackStorage;
}

// Ensure direct global access sees a valid shape in tests and non-browser runtimes.
getLocalStorage();
