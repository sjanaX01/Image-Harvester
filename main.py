from fastapi import FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from routes.scrape import router as scrape_router
from routes.download import router as download_router

app = FastAPI(title="ImageHarvest")

app.include_router(scrape_router)
app.include_router(download_router)


@app.get("/")
async def index():
    return FileResponse("static/index.html")


# Mounted last so it doesn't override named routes
app.mount("/static", StaticFiles(directory="static"), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

