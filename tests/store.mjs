// A stand-in for the store's database with the same promises EmDash's plugin storage makes:
// filtered, ordered, paged queries and a write that only lands when nobody wrote in between.
function collection() {
  const rows = new Map();
  let clock = 0;
  const matches = (data, where = {}) => Object.entries(where).every(([key, value]) => value === undefined || data[key] === value);
  return {
    rows,
    async get(id) { return rows.get(id)?.data ?? null; },
    async put(id, data) { rows.set(id, { data: structuredClone(data), revision: String(++clock) }); },
    async delete(id) { return rows.delete(id); },
    async count(where) { return [...rows.values()].filter(row => matches(row.data, where)).length; },
    async query({ where, orderBy, limit = 50, cursor } = {}) {
      let all = [...rows.entries()].filter(([, row]) => matches(row.data, where));
      const [[field, direction] = []] = Object.entries(orderBy ?? {});
      if (field) all.sort(([, a], [, b]) => String(a.data[field]).localeCompare(String(b.data[field])) * (direction === "desc" ? -1 : 1));
      const start = cursor ? Number(cursor) : 0;
      const items = all.slice(start, start + limit).map(([id, row]) => ({ id, data: structuredClone(row.data) }));
      const hasMore = start + limit < all.length;
      return { items, hasMore, ...(hasMore ? { cursor: String(start + limit) } : {}) };
    },
    async getVersioned(id) { const row = rows.get(id); return row ? { value: structuredClone(row.data), revision: row.revision } : null; },
    async compareAndSet(id, expected, data) {
      if ((rows.get(id)?.revision ?? null) !== expected) return { applied: false };
      rows.set(id, { data: structuredClone(data), revision: String(++clock) });
      return { applied: true };
    },
  };
}

export function store() {
  const kv = new Map();
  let turn = 0;
  return {
    storage: { reviews: collection(), ratings: collection(), shipped: collection() },
    kv: {
      async get(key) { return kv.get(key)?.value ?? null; },
      async set(key, value) { kv.set(key, { value, revision: String(++turn) }); },
      async delete(key) { return kv.delete(key); },
      async getVersioned(key) { return kv.get(key) ?? null; },
      async compareAndSet(key, expected, value) {
        if ((kv.get(key)?.revision ?? null) !== expected) return { applied: false };
        kv.set(key, { value, revision: String(++turn) });
        return { applied: true };
      },
    },
  };
}

let minute = 0;
/** A buyer's review as the store keeps it; each one is a minute newer than the last. */
export const review = (over = {}) => ({
  productId: "mug", productName: "Camp Mug", stars: 5, body: "Keeps coffee hot.", name: "Sam T.", status: "published",
  createdAt: new Date(Date.UTC(2026, 10, 1, 12, minute++)).toISOString(), orderId: `order-${minute}`, ...over,
});

export const staff = (input, role = 40) => ({
  input, ui: { surface: "admin-page", locale: "en", direction: "ltr" },
  user: { id: "u1", email: "staff@example.test", name: "Staff", role, createdAt: "" },
  request: { url: "", method: "POST", headers: {} },
});
export const shopper = url => ({ input: undefined, request: { url, method: "GET", headers: {} } });

/** The store's courier: a call to a private door from the store's own code, with no signed-in person. */
export const courier = input => ({ input: { courier: 1, ...input }, request: { url: "", method: "POST", headers: {} } });
