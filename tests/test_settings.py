from telmoni_claude import settings


def test_the_environment_comes_before_the_plugins_own_setting():
    both = {"TELMONI_API_KEY": "from-env", "CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": "from-plugin"}
    assert settings.option("TELMONI_API_KEY", both) == "from-env"
    own = {"CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": "from-plugin"}
    assert settings.option("TELMONI_API_KEY", own) == "from-plugin"
    blank = {"TELMONI_API_KEY": "  ", "CLAUDE_PLUGIN_OPTION_TELMONI_API_KEY": "from-plugin"}
    assert settings.option("TELMONI_API_KEY", blank) == "from-plugin"


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
