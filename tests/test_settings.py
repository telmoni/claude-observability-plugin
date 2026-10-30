from telmoni_claude import settings


def test_a_key_goes_only_with_the_endpoint_named_beside_it(tmp_path):
    base = {"CLAUDE_CONFIG_DIR": str(tmp_path)}
    plugin = {
        "CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": "from-plugin",
        "CLAUDE_PLUGIN_OPTION_TELMONI_ENDPOINT": "https://plugin.example",
    }
    read = settings.Settings.read({**base, **plugin, "TELMONI_ENDPOINT": "https://repo.example"})
    assert (read.api_key, read.endpoint) == ("from-plugin", "https://plugin.example")
    read = settings.Settings.read({**base, **plugin, "TELMONI_API_KEY": "from-env"})
    assert (read.api_key, read.endpoint) == ("from-env", settings.DEFAULT_ENDPOINT)
    blank = {**base, **plugin, "TELMONI_API_KEY": "  ", "TELMONI_ENDPOINT": "https://repo.example"}
    read = settings.Settings.read(blank)
    assert (read.api_key, read.endpoint) == ("from-plugin", "https://plugin.example")


def test_the_state_lives_in_the_plugins_data_folder(tmp_path):
    data = tmp_path / "data"
    assert settings.state_dir({"CLAUDE_PLUGIN_DATA": str(data)}) == data
    assert data.is_dir()


def test_without_a_data_folder_the_state_lives_under_the_config_folder(tmp_path):
    env = {"CLAUDE_PLUGIN_DATA": "relative/path", "CLAUDE_CONFIG_DIR": str(tmp_path)}
    assert settings.state_dir(env) == tmp_path / "telmoni"


def test_settings_read_their_defaults(tmp_path):
    read = settings.Settings.read({"CLAUDE_CONFIG_DIR": str(tmp_path)})
    assert read.api_key is None
    assert read.endpoint == settings.DEFAULT_ENDPOINT


def test_the_provider_follows_claude_codes_switches():
    assert settings.provider_of({}) == "anthropic"
    assert settings.provider_of({"CLAUDE_CODE_USE_BEDROCK": "1"}) == "aws.bedrock"
    assert settings.provider_of({"CLAUDE_CODE_USE_VERTEX": "TRUE"}) == "gcp.vertex_ai"
    assert settings.provider_of({"CLAUDE_CODE_USE_FOUNDRY": "1"}) == "azure.ai.inference"
    assert settings.provider_of({"CLAUDE_CODE_USE_BEDROCK": "0"}) == "anthropic"


def test_a_relative_config_folder_is_never_taken(tmp_path, monkeypatch):
    monkeypatch.setenv("HOME", str(tmp_path))
    assert settings.state_dir({"CLAUDE_CONFIG_DIR": "relative"}) == tmp_path / ".claude" / "telmoni"


def test_the_state_folder_is_the_owners_alone(tmp_path):
    made = settings.state_dir({"CLAUDE_PLUGIN_DATA": str(tmp_path / "data")})
    assert made.stat().st_mode & 0o777 == 0o700


def test_a_state_folder_an_earlier_version_left_open_is_closed(tmp_path):
    data = tmp_path / "data"
    data.mkdir(mode=0o755)
    data.chmod(0o755)
    settings.state_dir({"CLAUDE_PLUGIN_DATA": str(data)})
    assert data.stat().st_mode & 0o777 == 0o700
