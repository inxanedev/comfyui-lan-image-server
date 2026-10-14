from .lan_image_server import ServeImageLAN, ServeTextLAN, ServeResolutionLAN

NODE_CLASS_MAPPINGS = {
    "Serve Image on LAN": ServeImageLAN,
    "Serve Text on LAN": ServeTextLAN,
    "Serve Resolution on LAN": ServeResolutionLAN,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Serve Image on LAN": "Serve Image on LAN",
    "Serve Text on LAN": "Serve Text on LAN",
    "Serve Resolution on LAN": "Serve Resolution on LAN",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]