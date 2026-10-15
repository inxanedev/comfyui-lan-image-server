from .lan_image_server import ServeImageLAN, FetchGenerationSettingsLAN

NODE_CLASS_MAPPINGS = {
    "Serve Image on LAN": ServeImageLAN,
    "Fetch Generation Settings (LAN)": FetchGenerationSettingsLAN,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Serve Image on LAN": "Serve Image on LAN",
    "Fetch Generation Settings (LAN)": "Fetch Generation Settings (LAN)",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
