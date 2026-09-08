/** A no-network example. Export execute(request, context), or search(query, context). */
export async function execute(request, context) {
  context.signal.throwIfAborted();
  context.logger.info('Searching the local example catalog');
  const catalog = [
    { title: 'Node.js documentation', url: 'https://nodejs.org/docs/latest/api/', snippet: 'JavaScript and TypeScript runtime documentation.' },
    { title: 'nb-search', url: 'https://github.com/NB-Corp/nb-search', snippet: 'Search, read and research with configurable lanes.' },
  ];
  const query = request.query.toLowerCase();
  return catalog.filter((row) => `${row.title} ${row.snippet}`.toLowerCase().includes(query)).slice(0, request.limit);
}
