let currentTask = Promise.resolve();

const activeTaskVersions: { [id: string]: number } = {};

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function getNextTaskVersion(id: string): number {
  const nextVer = (activeTaskVersions[id] || 0) + 1;
  activeTaskVersions[id] = nextVer;
  return nextVer;
}

export function isTaskVersionActive(id: string, version: number): boolean {
  return activeTaskVersions[id] === version;
}

export function enqueueHeavyTask<T>(
  task: () => T | Promise<T>,
  id?: string,
  version?: number
): Promise<T | null> {
  return new Promise((resolve, reject) => {
    currentTask = currentTask.then(() => {
      const runTask = () => {
        // If a specific task version is no longer active, skip it immediately
        if (id && version !== undefined && !isTaskVersionActive(id, version)) {
          resolve(null);
          return Promise.resolve();
        }

        return new Promise<void>((innerResolve) => {
          // Yield to the browser before starting the task
          setTimeout(async () => {
            try {
              if (id && version !== undefined && !isTaskVersionActive(id, version)) {
                resolve(null);
              } else {
                const result = await task();
                resolve(result);
              }
            } catch (e) {
              reject(e);
            } finally {
              // Add a small delay after the task to ensure browser gets time to paint
              setTimeout(innerResolve, 20);
            }
          }, 20);
        });
      };

      if (typeof document !== 'undefined' && document.hidden) {
        return new Promise<void>((innerResolve) => {
          const onVisible = async () => {
            document.removeEventListener('visibilitychange', onVisible);
            await runTask();
            innerResolve();
          };
          document.addEventListener('visibilitychange', onVisible);
        });
      } else {
        return runTask();
      }
    });
  });
}
