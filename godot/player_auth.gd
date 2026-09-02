class_name TyagaPlayerAuth
extends Node

const POLL_INTERVAL_SECONDS := 1.0
const DEVICE_AUTH_TIMEOUT_SECONDS := 300.0

var session_token := ""
var auth_client: TyagaAuthClient

func _ready() -> void:
    auth_client = TyagaAuthClient.new()
    add_child(auth_client)

func restore_saved_session() -> Dictionary:
    var saved_token := auth_client.load_session_token()

    if saved_token.is_empty():
        return {
            "success": false,
            "error": "session_not_found"
        }

    var player_result: Dictionary = await auth_client.get_me(
        saved_token
    )

    if player_result.get("success", false):
        session_token = saved_token
        _apply_player_result(player_result)

        return {
            "success": true,
            "token": saved_token,
            "player": player_result
        }

    if int(player_result.get("http_status", 0)) == 401:
        auth_client.clear_session_token()

    return player_result

func authenticate_player() -> Dictionary:
    var start_result: Dictionary = await auth_client.start_device_auth()

    if not start_result.get("success", false):
        return start_result

    var challenge: String = start_result.get(
        "challenge",
        ""
    )
    var exchange_code: String = start_result.get(
        "exchange_code",
        ""
    )
    var auth_url: String = start_result.get(
        "auth_url",
        ""
    )

    if (
        challenge.is_empty() ||
        exchange_code.is_empty() ||
        auth_url.is_empty()
    ):
        return {
            "success": false,
            "error": "invalid_device_auth_start_response"
        }

    OS.shell_open(auth_url)

    var deadline: float = (
        Time.get_ticks_msec() / 1000.0 +
        DEVICE_AUTH_TIMEOUT_SECONDS
    )
    var completed := false

    while Time.get_ticks_msec() / 1000.0 < deadline:
        var status_result: Dictionary = (
            await auth_client.get_device_status(
                challenge
            )
        )

        var status: String = status_result.get(
            "status",
            ""
        )

        if status == "completed":
            completed = true
            break

        if status == "expired" or status == "consumed":
            return {
                "success": false,
                "error": "device_auth_unavailable",
                "status": status
            }

        if not status_result.get("success", false):
            return status_result

        await get_tree().create_timer(
            POLL_INTERVAL_SECONDS
        ).timeout

    if not completed:
        return {
            "success": false,
            "error": "device_auth_timeout"
        }

    var exchange_result: Dictionary = (
        await auth_client.exchange_device_auth(
            challenge,
            exchange_code
        )
    )

    if not exchange_result.get("success", false):
        return exchange_result

    session_token = exchange_result.get(
        "token",
        ""
    )

    if session_token.is_empty():
        return {
            "success": false,
            "error": "session_token_missing"
        }

    var player_result: Dictionary = await auth_client.get_me(
        session_token
    )

    if not player_result.get("success", false):
        return player_result

    var save_token_result: Dictionary = (
        auth_client.save_session_token(session_token)
    )

    if not save_token_result.get("success", false):
        return save_token_result

    _apply_player_result(player_result)

    var save_result := auth_client.save_player_json(
        player_result
    )

    return {
        "success": true,
        "token": session_token,
        "player": player_result,
        "file": save_result.get("path", "")
    }

func logout() -> void:
    session_token = ""
    auth_client.clear_session_token()

func _apply_player_result(player_result: Dictionary) -> void:
    var player: Dictionary = player_result.get(
        "player",
        {}
    )
    var profile: Dictionary = player_result.get(
        "profile",
        {}
    )

    PlayerData.token = session_token
    PlayerData.player_id = int(player.get("id", 0))
    PlayerData.points = int(player.get("points", 0))
    PlayerData.player_name = str(
        profile.get("nickname", "")
    )
    PlayerData.photo_url = str(
        profile.get("avatar_url", "")
    )
    PlayerData.save_data()
