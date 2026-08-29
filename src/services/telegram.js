const crypto = require('crypto');

const TELEGRAM_AUTH_MAX_AGE_SECONDS = Number(
    process.env.TELEGRAM_AUTH_MAX_AGE_SECONDS || 600
);

/**
 * Получить Telegram Bot Token.
 */
function getBotToken() {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (
        typeof token !== 'string' ||
        token.length === 0
    ) {
        throw new Error(
            'TELEGRAM_BOT_TOKEN is not configured'
        );
    }

    return token;
}

/**
 * Создать secret key для проверки Telegram WebApp initData.
 *
 * secret_key = HMAC-SHA256(
 *     key = "WebAppData",
 *     data = bot_token
 * )
 */
function createSecretKey(botToken) {
    return crypto
        .createHmac('sha256', 'WebAppData')
        .update(botToken)
        .digest();
}

/**
 * Построить data-check-string.
 *
 * Все поля кроме hash:
 *
 * key=value
 *
 * сортируются по key и объединяются через \n.
 */
function buildDataCheckString(params) {
    const entries = [];

    for (const [key, value] of params.entries()) {
        if (key === 'hash') {
            continue;
        }

        entries.push(`${key}=${value}`);
    }

    entries.sort();

    return entries.join('\n');
}

/**
 * Проверить HMAC подпись Telegram WebApp initData.
 */
function verifySignature(params) {
    const receivedHash = params.get('hash');

    if (
        typeof receivedHash !== 'string' ||
        !/^[0-9a-f]{64}$/i.test(receivedHash)
    ) {
        return false;
    }

    const dataCheckString =
        buildDataCheckString(params);

    const secretKey =
        createSecretKey(getBotToken());

    const calculatedHash =
        crypto
            .createHmac('sha256', secretKey)
            .update(dataCheckString)
            .digest('hex');

    const receivedHashBuffer =
        Buffer.from(receivedHash, 'hex');

    const calculatedHashBuffer =
        Buffer.from(calculatedHash, 'hex');

    if (
        receivedHashBuffer.length !==
        calculatedHashBuffer.length
    ) {
        return false;
    }

    return crypto.timingSafeEqual(
        calculatedHashBuffer,
        receivedHashBuffer
    );
}

/**
 * Проверить auth_date.
 */
function verifyAuthDate(params) {
    const authDateRaw =
        params.get('auth_date');

    if (
        typeof authDateRaw !== 'string' ||
        !/^\d+$/.test(authDateRaw)
    ) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    const authDate =
        Number(authDateRaw);

    if (!Number.isSafeInteger(authDate)) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    const now =
        Math.floor(Date.now() / 1000);

    const age =
        now - authDate;

    /*
     * Небольшой запас на рассинхронизацию часов.
     */
    if (age < -60) {
        return {
            valid: false,
            error: 'invalid_auth_date'
        };
    }

    if (
        age >
        TELEGRAM_AUTH_MAX_AGE_SECONDS
    ) {
        return {
            valid: false,
            error: 'telegram_auth_data_expired'
        };
    }

    return {
        valid: true,
        authDate
    };
}

/**
 * Извлечь Telegram user из initData.
 */
function parseTelegramUser(params) {
    const userRaw =
        params.get('user');

    if (
        typeof userRaw !== 'string' ||
        userRaw.length === 0
    ) {
        return {
            valid: false,
            error: 'telegram_user_missing'
        };
    }

    let user;

    try {
        user = JSON.parse(userRaw);
    } catch {
        return {
            valid: false,
            error: 'invalid_telegram_user'
        };
    }

    if (
        user === null ||
        typeof user !== 'object' ||
        Array.isArray(user)
    ) {
        return {
            valid: false,
            error: 'invalid_telegram_user'
        };
    }

    /*
     * Telegram user.id проверяем как безопасное целое.
     */
    if (
        !Number.isSafeInteger(user.id) ||
        user.id <= 0
    ) {
        return {
            valid: false,
            error: 'invalid_telegram_user_id'
        };
    }

    return {
        valid: true,
        user
    };
}

/**
 * Полная проверка Telegram Mini App initData.
 */
function validateInitData(initData) {
    if (
        typeof initData !== 'string' ||
        initData.length === 0
    ) {
        return {
            valid: false,
            error: 'init_data_required'
        };
    }

    let params;

    try {
        params =
            new URLSearchParams(initData);
    } catch {
        return {
            valid: false,
            error: 'invalid_init_data'
        };
    }

    /*
     * Без hash проверять нечего.
     */
    if (!params.has('hash')) {
        return {
            valid: false,
            error: 'telegram_hash_missing'
        };
    }

    /*
     * Сначала проверяем подпись.
     */
    if (!verifySignature(params)) {
        return {
            valid: false,
            error: 'invalid_telegram_signature'
        };
    }

    /*
     * Затем проверяем свежесть данных.
     */
    const authDateResult =
        verifyAuthDate(params);

    if (!authDateResult.valid) {
        return authDateResult;
    }

    /*
     * Получаем Telegram user.
     */
    const userResult =
        parseTelegramUser(params);

    if (!userResult.valid) {
        return userResult;
    }

    return {
        valid: true,
        user: userResult.user,
        authDate: authDateResult.authDate
    };
}

module.exports = {
    validateInitData
};
