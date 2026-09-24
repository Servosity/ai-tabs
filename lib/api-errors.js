/**
 * Terminal handlers for the /api surface.
 *
 * Every /api client parses the reply with res.json(). Express's built-in 404
 * and error handlers render HTML, so a missing route or a body-parse failure
 * arrives at the call site as "Unexpected token '<'" — an error that names
 * neither the endpoint nor the cause. These two keep the contract: an /api
 * request gets JSON back, whatever happened.
 *
 * Mount both AFTER every /api route, the 404 first.
 */

/** Unknown /api route → JSON 404 that names the endpoint and the server build. */
function apiNotFound(serverVersion) {
  return (req, res) => {
    res.status(404).json({
      error: `No such endpoint: ${req.method} ${req.originalUrl}`,
      code: 'UNKNOWN_ENDPOINT',
      serverVersion,
    });
  };
}

/** Anything thrown by an /api route or its middleware → JSON error body. */
function apiErrorHandler(log = console.error) {
  return (err, req, res, next) => {
    if (res.headersSent) return next(err);
    log(`[api] ${req.method} ${req.originalUrl} failed:`, err);
    res.status(err.status || err.statusCode || 500).json({
      error: err.message || 'Internal server error',
      code: err.code,
    });
  };
}

module.exports = { apiNotFound, apiErrorHandler };
