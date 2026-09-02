extends Control

@export var auth_button: Button

var player_auth: TyagaPlayerAuth

func _ready() -> void:
    player_auth = TyagaPlayerAuth.new()
    add_child(player_auth)

    auth_button.disabled = true
    auth_button.text = "Проверка сессии..."
    auth_button.pressed.connect(_on_auth_pressed)

    var restore_result: Dictionary = (
        await player_auth.restore_saved_session()
    )

    if restore_result.get("success", false):
        _open_main_scene()
        return

    auth_button.disabled = false
    auth_button.text = "Войти через Telegram"

func _on_auth_pressed() -> void:
    auth_button.disabled = true
    auth_button.text = "Авторизация..."

    var result: Dictionary = (
        await player_auth.authenticate_player()
    )

    if not result.get("success", false):
        print("=== AUTH ERROR ===")
        print(result)
        auth_button.disabled = false
        auth_button.text = "Войти через Telegram"
        return

    _open_main_scene()

func _open_main_scene() -> void:
    get_tree().change_scene_to_file(
        "res://scenes/main.tscn"
    )
