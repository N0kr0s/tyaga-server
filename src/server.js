require('dotenv').config();

const path = require('path');
const fastifyStatic = require('@fastify/static');

const fastify = require('fastify')({
    logger: true
});

const pool = require('./db');

const playerRoutes = require('./routes/players');
const skinsRoutes = require('./routes/skins');
const achievementRoutes = require('./routes/achievements');
const sessionRoutes = require('./routes/sessions');
const authRoutes = require('./routes/auth');

const { requireAuth } = require('./services/auth');

fastify.decorate('authenticate', requireAuth);

// ============================================================
// HEALTH
// ============================================================

fastify.get('/health', async (request, reply) => {
    try {
        await pool.query('SELECT 1');

        return {
            status: 'ok',
            database: true
        };
    } catch (error) {
        fastify.log.error(error);

        return reply.code(503).send({
            status: 'error',
            database: false
        });
    }
});

// ============================================================
// API ROUTES
// ============================================================

fastify.register(playerRoutes);
fastify.register(skinsRoutes);
fastify.register(achievementRoutes);
fastify.register(sessionRoutes);
fastify.register(authRoutes);

// ============================================================
// STATIC FILES
// ============================================================

fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../public')
});

// ============================================================
// HTML PAGES
// ============================================================

fastify.get('/telegram/app', async (request, reply) => {
    return reply.sendFile('telegram/app.html');
});

fastify.get('/telegram/app/', async (request, reply) => {
    return reply.sendFile('telegram/app.html');
});

fastify.get('/auth', async (request, reply) => {
    return reply.sendFile('auth/index.html');
});

fastify.get('/telegram', async (request, reply) => {
    return reply.sendFile('telegram/index.html');
});

// ============================================================
// START SERVER
// ============================================================

const start = async () => {
    const host = process.env.HOST || '127.0.0.1';
    const port = Number(process.env.PORT || 3000);

    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`Invalid PORT: ${process.env.PORT}`);
    }

    try {
        await fastify.listen({
            host,
            port
        });

        fastify.log.info(
            `TYAGA server listening on ${host}:${port}`
        );
    } catch (error) {
        fastify.log.error(error);
        process.exit(1);
    }
};

start();
