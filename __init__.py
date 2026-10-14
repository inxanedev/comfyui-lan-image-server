from .lan_image_server import ServeImageLAN

NODE_CLASS_MAPPINGS = {
    "Serve Image on LAN": ServeImageLAN
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "Serve Image on LAN": "Serve Image on LAN"
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]