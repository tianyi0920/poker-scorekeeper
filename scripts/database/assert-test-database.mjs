const url = new URL(process.env.DATABASE_URL);
const database = url.pathname.slice(1);

if (!database.endsWith('_test')) {
  throw new Error(`Refusing destructive test operation on database: ${database}`);
}
