class_name TyagaAuthClient
extends Node

const API_BASE_URL := "https://api.tyaga-game.ru"
const SESSION_KEY_PATH := "user://tyaga_session.key"
const SESSION_DATA_PATH := "user://tyaga_session.bin"
const AES_KEY_SIZE := 32
const AES_IV_SIZE := 16
const HMAC_SIZE := 32
const AES_BLOCK_SIZE := 16

func _request(
    method: int,
    path: String,
    payload: Dictionary = {},
    headers: PackedStringArray = PackedStringArray()
) -> Dictionary:
    var request := HTTPRequest.new()
    add_child(request)

    var request_headers := headers.duplicate()
    var body := ""

    if method == HTTPClient.METHOD_POST:
        request_headers.append("Content-Type: application/json")
        body = JSON.stringify(payload)

    var request_error := request.request(
        API_BASE_URL + path,
        request_headers,
        method,
        body
    )

    if request_error != OK:
        request.queue_free()
        return {
            "success": false,
            "error": "http_request_failed",
            "godot_error": request_error
        }

    var completed = await request.request_completed
    request.queue_free()

    var response_code: int = completed[1]
    var response_body: PackedByteArray = completed[3]
    var response_text := response_body.get_string_from_utf8()
    var data = JSON.parse_string(response_text)

    if typeof(data) != TYPE_DICTIONARY:
        return {
            "success": false,
            "error": "invalid_json_response",
            "http_status": response_code
        }

    if response_code < 200 or response_code >= 300:
        data["success"] = false
        data["http_status"] = response_code
    else:
        data["success"] = true

    return data

func start_device_auth() -> Dictionary:
    return await _request(
        HTTPClient.METHOD_POST,
        "/auth/device/start"
    )

func get_device_status(challenge: String) -> Dictionary:
    return await _request(
        HTTPClient.METHOD_POST,
        "/auth/device/status",
        {
            "challenge": challenge
        }
    )

func exchange_device_auth(
    challenge: String,
    exchange_code: String
) -> Dictionary:
    return await _request(
        HTTPClient.METHOD_POST,
        "/auth/device/exchange",
        {
            "challenge": challenge,
            "exchange_code": exchange_code
        }
    )

func get_me(session_token: String) -> Dictionary:
    var headers := PackedStringArray()
    headers.append(
        "Authorization: Bearer " + session_token
    )

    return await _request(
        HTTPClient.METHOD_GET,
        "/auth/me",
        {},
        headers
    )

func save_session_token(session_token: String) -> Dictionary:
    if session_token.is_empty():
        return {
            "success": false,
            "error": "session_token_missing"
        }

    var crypto := Crypto.new()
    var key := _get_or_create_session_key(crypto)

    if key.size() != AES_KEY_SIZE:
        return {
            "success": false,
            "error": "session_key_unavailable"
        }

    var iv := crypto.generate_random_bytes(AES_IV_SIZE)
    var aes := AESContext.new()
    var start_error := aes.start(
        AESContext.MODE_CBC_ENCRYPT,
        key,
        iv
    )

    if start_error != OK:
        return {
            "success": false,
            "error": "session_encrypt_failed",
            "godot_error": start_error
        }

    var plaintext := _pad(
        session_token.to_utf8_buffer()
    )
    var encrypted := aes.update(plaintext)
    aes.finish()
    var ciphertext := iv + encrypted
    var mac := crypto.hmac_digest(
        HashingContext.HASH_SHA256,
        key,
        ciphertext
    )

    var file := FileAccess.open(
        SESSION_DATA_PATH,
        FileAccess.WRITE
    )

    if file == null:
        return {
            "success": false,
            "error": "session_file_open_failed"
        }

    file.store_buffer(ciphertext + mac)
    file.close()

    return {
        "success": true
    }

func load_session_token() -> String:
    if (
        not FileAccess.file_exists(SESSION_KEY_PATH) ||
        not FileAccess.file_exists(SESSION_DATA_PATH)
    ):
        return ""

    var key_file := FileAccess.open(
        SESSION_KEY_PATH,
        FileAccess.READ
    )
    var data_file := FileAccess.open(
        SESSION_DATA_PATH,
        FileAccess.READ
    )

    if key_file == null or data_file == null:
        return ""

    var key := key_file.get_buffer(AES_KEY_SIZE)
    var payload := data_file.get_buffer(
        data_file.get_length()
    )
    key_file.close()
    data_file.close()

    if (
        key.size() != AES_KEY_SIZE ||
        payload.size() <= AES_IV_SIZE + HMAC_SIZE
    ):
        return ""

    var ciphertext_size := payload.size() - HMAC_SIZE
    var ciphertext := payload.slice(0, ciphertext_size)
    var stored_mac := payload.slice(ciphertext_size)
    var crypto := Crypto.new()
    var expected_mac := crypto.hmac_digest(
        HashingContext.HASH_SHA256,
        key,
        ciphertext
    )

    if not crypto.constant_time_compare(
        expected_mac,
        stored_mac
    ):
        return ""

    var iv := ciphertext.slice(0, AES_IV_SIZE)
    var encrypted := ciphertext.slice(AES_IV_SIZE)
    var aes := AESContext.new()

    if aes.start(
        AESContext.MODE_CBC_DECRYPT,
        key,
        iv
    ) != OK:
        return ""

    var decrypted := aes.update(encrypted)
    aes.finish()
    var unpadded := _unpad(decrypted)

    if unpadded.is_empty():
        return ""

    return unpadded.get_string_from_utf8()

func clear_session_token() -> void:
    if FileAccess.file_exists(SESSION_DATA_PATH):
        DirAccess.remove_absolute(
            ProjectSettings.globalize_path(
                SESSION_DATA_PATH
            )
        )

func _get_or_create_session_key(crypto: Crypto) -> PackedByteArray:
    if FileAccess.file_exists(SESSION_KEY_PATH):
        var existing_file := FileAccess.open(
            SESSION_KEY_PATH,
            FileAccess.READ
        )

        if existing_file != null:
            var existing_key := existing_file.get_buffer(
                AES_KEY_SIZE
            )
            existing_file.close()

            if existing_key.size() == AES_KEY_SIZE:
                return existing_key

    var key := crypto.generate_random_bytes(AES_KEY_SIZE)
    var key_file := FileAccess.open(
        SESSION_KEY_PATH,
        FileAccess.WRITE
    )

    if key_file == null:
        return PackedByteArray()

    key_file.store_buffer(key)
    key_file.close()
    return key

func _pad(data: PackedByteArray) -> PackedByteArray:
    var padded := data.duplicate()
    var padding_size := AES_BLOCK_SIZE - (
        data.size() % AES_BLOCK_SIZE
    )

    for _i in range(padding_size):
        padded.append(padding_size)

    return padded

func _unpad(data: PackedByteArray) -> PackedByteArray:
    if data.is_empty():
        return PackedByteArray()

    var padding_size: int = data[data.size() - 1]

    if (
        padding_size < 1 ||
        padding_size > AES_BLOCK_SIZE ||
        padding_size > data.size()
    ):
        return PackedByteArray()

    for i in range(
        data.size() - padding_size,
        data.size()
    ):
        if data[i] != padding_size:
            return PackedByteArray()

    return data.slice(
        0,
        data.size() - padding_size
    )

func save_player_json(player_data: Dictionary) -> Dictionary:
    var file := FileAccess.open(
        "user://player.json",
        FileAccess.WRITE
    )

    if file == null:
        return {
            "success": false,
            "error": "player_file_open_failed"
        }

    file.store_string(
        JSON.stringify(player_data)
    )
    file.close()

    return {
        "success": true,
        "path": "user://player.json"
    }
