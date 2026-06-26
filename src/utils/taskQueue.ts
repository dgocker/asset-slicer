let currentTask = Promise.resolve();

export function enqueueHeavyTask<T>(task: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    currentTask = currentTask.then(() => {
      return new Promise<void>((innerResolve) => {
        // Yield to the browser before starting the task
        setTimeout(() => {
          try {
            resolve(task());
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
