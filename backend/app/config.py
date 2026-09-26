from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=(".env", "../.env"), extra="ignore")

    database_url: str = "postgresql+psycopg://gearbox:gearbox@localhost:5433/gearbox"
    upload_dir: str = "data/uploads"
    # dataset library: one folder per dataset with a SHA256SUMS file (repo `data/`)
    data_dir: str = "../data"

    # LLM explanations: any OpenAI-compatible endpoint (OpenRouter default, OpenCode Zen works too)
    llm_base_url: str = "https://openrouter.ai/api/v1"
    llm_model: str = "anthropic/claude-sonnet-5"
    llm_api_key: str = ""
    openrouter_api_key: str = ""
    llm_timeout_s: float = 45.0  # read timeout per LLM call; the connect timeout is 5 s
    admin_token: str = ""  # protects GET /chat/log
    # demo day: no uploads, no re-analysis - nobody can occupy the single analysis worker
    read_only: bool = False

    # upload limits: the Tesla set is 8 files, 286 MB raw (about 60 MB gzip-compressed)
    max_upload_files: int = 64
    max_upload_file_mb: int = 1024
    max_upload_total_mb: int = 4096
    # an analysis that runs longer than this is stopped and marked as failed
    analysis_timeout_s: int = 1800

    @property
    def llm_key(self) -> str:
        return self.llm_api_key or self.openrouter_api_key


settings = Settings()
