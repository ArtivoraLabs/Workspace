from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


def _csv(value: str) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: str = "dev"
    cors_origins: str = "*"
    jwt_secret: str = ""
    auth_required: bool = True
    allowed_roles: str = "owner,admin"
    service_api_keys: str = ""
    rate_limit_per_min: int = 30
    redis_url: str = ""

    # Odoo
    odoo_url: str = ""
    odoo_db: str = ""
    odoo_username: str = ""
    odoo_api_key: str = ""
    odoo_allow_client_credentials: bool = False
    odoo_allowed_hosts: str = ""
    odoo_allowed_models: str = ""
    odoo_blocked_models: str = ""
    odoo_blocked_fields: str = ""
    odoo_timeout_s: float = 20.0
    odoo_max_concurrency_per_host: int = 6
    max_rows: int = 200
    cache_ttl_schema_s: int = 3600
    cache_ttl_data_s: int = 60

    # LLM
    anthropic_api_key: str = ""
    openai_api_key: str = ""
    gemini_api_key: str = ""
    xai_api_key: str = ""
    groq_api_key: str = ""
    provider_priority: str = "anthropic,openai,xai,groq,gemini"
    model_catalog_file: str = ""
    max_tool_hops: int = 8
    max_output_tokens: int = 4096
    tool_timeout_s: float = 45.0

    @property
    def cors_list(self) -> list[str]:
        return _csv(self.cors_origins) or ["*"]

    @property
    def roles(self) -> set[str]:
        return set(_csv(self.allowed_roles))

    @property
    def api_keys(self) -> set[str]:
        return set(_csv(self.service_api_keys))

    @property
    def allowed_hosts(self) -> list[str]:
        return _csv(self.odoo_allowed_hosts)

    @property
    def priority(self) -> list[str]:
        return _csv(self.provider_priority)

    def provider_key(self, provider: str) -> str:
        return {
            "anthropic": self.anthropic_api_key,
            "openai": self.openai_api_key,
            "gemini": self.gemini_api_key,
            "xai": self.xai_api_key,
            "groq": self.groq_api_key,
        }.get(provider, "")


@lru_cache
def get_settings() -> Settings:
    return Settings()
