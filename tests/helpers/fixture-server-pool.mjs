export async function withServerPool({
  count,
  createServer,
  listen,
  closeServer
}, operation) {
  const servers = [];
  const ports = [];
  let result;
  let primaryError;

  try {
    for (let index = 0; index < count; index += 1) {
      const server = createServer();
      const port = await listen(server);
      servers.push(server);
      ports.push(port);
    }
    result = await operation({ servers, ports });
  } catch (error) {
    primaryError = error;
  }

  const cleanup = await Promise.allSettled(
    servers.map((server) => closeServer(server))
  );
  if (primaryError) throw primaryError;
  if (cleanup.some(({ status }) => status === 'rejected')) {
    throw new Error('server_pool_cleanup_failed');
  }
  return result;
}

