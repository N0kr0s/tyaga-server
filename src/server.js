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

const { requireAuth } = require('./middleware/auth');

fastify.decorate('authenticate', requireAuth);

fastify.get('/health', async () => {
    try {
        await pool.query('SELECT 1');

        return {
            status: 'ok',
            database: true
        };
    } catch (error) {
        fastify.log.error(error);

        return {
            status: 'ok',
            database: false
        };
    }
});

fastify.register(playerRoutes);
fastify.register(skinsRoutes);
fastify.register(achievementRoutes);
fastify.register(sessionRoutes);
fastify.register(authRoutes);

fastify.register(fastifyStatic, {
    root: path.join(__dirname, '../public'),
});

const start = async () => {
    try {
        await fastify.listen({
            host: '127.0.0.1',
            port: 3000
        });
    } catch (error) {
        fastify.log.error(error);
        process.exit(1);
    }
};

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

start();
