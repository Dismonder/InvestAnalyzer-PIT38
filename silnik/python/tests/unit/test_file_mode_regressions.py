from investment_tax_engine.models.core import InputBundle
from investment_tax_engine.normalize.trades import SOURCE_PRIORITIES


def test_input_bundle_does_not_accept_api_live_snapshot_path():
    assert "api_live_json_path" not in InputBundle.__dataclass_fields__


def test_freedom24_api_live_is_not_an_active_source_priority():
    assert "FREEDOM24_API_LIVE" not in SOURCE_PRIORITIES
