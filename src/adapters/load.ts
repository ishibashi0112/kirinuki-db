/** Drivers are optional peer dependencies: install only the one for your database. (From ashiato.) */
export async function loadDriver<T>(pkg: string, label: string): Promise<T> {
  try {
    const mod = (await import(pkg)) as { default?: T } & T;
    return (mod.default ?? mod) as T;
  } catch (e) {
    const base = pkg.split("/")[0];
    throw new Error(`${label} に接続するには "${base}" パッケージが必要です。npm install ${base} で入れてください\n(${(e as Error).message})`);
  }
}
