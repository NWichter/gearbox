"""LLM fallback: explain and chat always give a usable text, also without a key or when the call fails."""

import httpx
import pytest
from conftest import finding

from app.airframe import chat, explain, playbook
from app.config import settings


@pytest.fixture
def f() -> dict:
    x = finding()
    playbook.annotate([x], {})
    return x


def test_no_key_gives_fallback(f, monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "")
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    text, source = explain.explain(f, {})
    assert source == "fallback"
    assert text.splitlines()[0] == "What happens: 802.1X authentication fails (3x)."
    assert "Who acts: You can repair this." in text
    assert f"What you do: {f['action']['supervisor']}" in text
    assert f"What IT does: {f['action']['it']}" in text
    assert "Details: EAP-Failure 3 times." in text
    assert text.endswith(explain.FALLBACK_NOTE)


@pytest.mark.parametrize(
    "error",
    [
        httpx.ConnectTimeout("timeout"),
        httpx.ReadTimeout("timeout"),
        httpx.HTTPStatusError(
            "500",
            request=httpx.Request("POST", "http://x"),
            response=httpx.Response(500),
        ),
        KeyError("choices"),
        ValueError("not json"),
    ],
)
def test_llm_error_gives_fallback(f, monkeypatch, error):
    monkeypatch.setattr(settings, "llm_api_key", "test-key")

    def boom(*a, **kw):
        raise error

    monkeypatch.setattr(explain, "complete", boom)
    text, source = explain.explain(f, {})
    assert source == "fallback"
    assert text.startswith("What happens:")


def test_llm_answer_is_used(f, monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    monkeypatch.setattr(explain, "complete", lambda *a, **kw: {"text": "Plain words."})
    assert explain.explain(f, {}) == ("Plain words.", "llm")


def test_empty_llm_answer_gives_fallback(f, monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "test-key")
    monkeypatch.setattr(explain, "complete", lambda *a, **kw: {"text": ""})
    assert explain.explain(f, {})[1] == "fallback"


def test_fallback_without_action_uses_recommendation():
    text = explain.fallback({"title": "X", "detail": "Y", "recommendation": "Do Z"})
    assert "Next step: Do Z." in text


def test_llm_calls_have_timeouts():
    t = explain.timeout()
    assert t.connect == 5.0
    assert t.read == settings.llm_timeout_s


def test_chat_without_key(monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "")
    monkeypatch.setattr(settings, "openrouter_api_key", "")
    text, ok = chat.answer("What is this?", [], "/", None)
    assert ok is False
    assert text == chat.NOT_CONFIGURED


def test_chat_timeout_gives_clear_message(monkeypatch):
    monkeypatch.setattr(settings, "llm_api_key", "test-key")

    def slow(*a, **kw):
        raise httpx.ReadTimeout("timeout")

    monkeypatch.setattr(chat, "complete", slow)
    monkeypatch.setattr(chat, "_docs_text", lambda: "")
    text, ok = chat.answer("What is this?", [], "/", None)
    assert ok is False
    assert "did not answer in time" in text


def test_prompts_ask_for_english_and_have_no_semicolons():
    assert "Always answer in English" in chat.SYSTEM
    assert ";" not in chat.SYSTEM and ";" not in explain.SYSTEM
