let currentTask = Promise.resolve();

export function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export function enqueueHeavyTask<T>(task: () => T | Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    currentTask = currentTask.then(() => {
      return new Promise<void>((innerResolve) => {
        // Yield to the browser before starting the task
        setTimeout(async () => {
          try {
            const result = await task();
            resolve(result);
          } catch (e) {
            reject(e);
          } finally {
            // Add a small delay after the task to ensure browser gets time to paint
            setTimeout(innerResolve, 20);
          }
        }, 20);
      });
    });
  });
}

