const client = require('prom-client');

const register = new client.Registry();

// Enable default metrics (CPU, Memory, etc.)
client.collectDefaultMetrics({ register });

// Custom API metrics
const httpRequestDurationMicroseconds = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10]
});

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code']
});

register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestsTotal);

// Middleware for recording metrics
const metricsMiddleware = (req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on('finish', () => {
    // Avoid high cardinality by stripping dynamic params
    const route = req.route ? req.route.path : req.url.split('?')[0];
    
    end({ 
      method: req.method, 
      route: route, 
      status_code: res.statusCode 
    });
    
    httpRequestsTotal.inc({ 
      method: req.method, 
      route: route, 
      status_code: res.statusCode 
    });
  });
  next();
};

const getMetricsRoute = async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
};

module.exports = {
  metricsMiddleware,
  getMetricsRoute
};
