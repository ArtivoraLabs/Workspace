from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=8000)


class OdooCreds(BaseModel):
    model_config = ConfigDict(populate_by_name=True)
    url: str
    db: str
    username: str
    api_key: str = Field(alias="apiKey")


class ChatRequest(BaseModel):
    messages: list[Message] = Field(min_length=1, max_length=40)
    model: str | None = None
    tier: Literal["auto", "fast", "smart", "deep"] = "auto"
    stream: bool = True
    odoo: OdooCreds | None = None  # only honoured if ODOO_ALLOW_CLIENT_CREDENTIALS=true


class Feedback(BaseModel):
    request_id: str = Field(max_length=40)
    rating: Literal["up", "down"]
    comment: str = Field(default="", max_length=1000)
    expected: str = Field(default="", max_length=1000)  # what the right answer should have been
