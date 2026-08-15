"""DeCloud — route blueprints registry."""


def register_blueprints(app, sock):
    from .auth import bp as auth_bp
    app.register_blueprint(auth_bp)

    from .pwa import bp as pwa_bp
    app.register_blueprint(pwa_bp)

    from .system import bp as system_bp
    app.register_blueprint(system_bp)

    from .books import bp as books_bp
    app.register_blueprint(books_bp)

    from .terminal import bp as terminal_bp
    app.register_blueprint(terminal_bp)

    from .agents import bp as agents_bp
    app.register_blueprint(agents_bp)

    from .lego import bp as lego_bp
    app.register_blueprint(lego_bp)

    from .ollama import bp as ollama_bp
    app.register_blueprint(ollama_bp)

    from .comfy import bp as comfy_bp
    app.register_blueprint(comfy_bp)

    from .voice import bp as voice_bp
    app.register_blueprint(voice_bp)

    from .projects import bp as projects_bp
    app.register_blueprint(projects_bp)

    from .osint import bp as osint_bp
    app.register_blueprint(osint_bp)

    from .universe import bp as universe_bp
    app.register_blueprint(universe_bp)

    from .settings import bp as settings_bp
    app.register_blueprint(settings_bp)

    from .devices import bp as devices_bp
    app.register_blueprint(devices_bp)

    from .telemetry import bp as telemetry_bp
    app.register_blueprint(telemetry_bp)

    from .music import bp as music_bp
    app.register_blueprint(music_bp)

    from .version import bp as version_bp
    app.register_blueprint(version_bp)

    # WebSocket routes (need sock instance)
    if sock is not None:
        from .terminal import register as register_terminal
        register_terminal(sock)

        from .voice import register as register_voice
        register_voice(sock)
