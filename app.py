import os
import json
from flask import Flask, request, jsonify
from flask_cors import CORS
import google.generativeai as genai

app = Flask(__name__)
# Crucial: This allows your GitHub Pages HTML to talk to your Render Python server
CORS(app) 

# Configure Gemini (Render will securely inject this from your dashboard)
api_key = os.environ.get("GEMINI_API_KEY")
if api_key:
    genai.configure(api_key=api_key)

@app.route('/api/scan', methods=['POST'])
def scan_store():
    data = request.json
    store_name = data.get('storeName', 'Unknown Store')
    images_data = data.get('images', [])

    if not images_data:
        return jsonify({"error": "No images provided"}), 400

    try:
        model = genai.GenerativeModel('gemini-1.5-flash')
        
        # Format images for Gemini
        parts = []
        for img in images_data:
            parts.append({
                "mime_type": "image/jpeg",
                "data": img['b64']
            })

        # The strict instruction manual for the AI
        prompt = f"""
        You are a retail VM compliance auditor for store '{store_name}'.
        Analyze every image provided. For the standard VM parameters (facade, layout, cash, product, fashion, bin, nesting, signage, hygiene, stockroom), evaluate if they PASS, FAIL, or are NA.
        
        Return ONLY valid JSON (no markdown, no code fences, no explanation):
        {{
          "categories": [
            {{ "id": "facade", "params": [ {{ "status": "PASS", "slide": 1, "note": "Clean window display" }} ] }}
          ],
          "summary": "2-4 sentence overall VM health summary"
        }}
        """
        parts.append(prompt)

        # Fire the request to Google
        response = model.generate_content(parts)

        # Strip away any markdown formatting Google tries to sneak in
        clean_text = response.text.replace("```json", "").replace("```", "").strip()
        return jsonify(json.loads(clean_text))

    except Exception as e:
        print(f"Server Error: {e}")
        return jsonify({"error": "Failed to process images with AI."}), 500

if __name__ == '__main__':
    # Gunicorn ignores this block in production, which is exactly what we want
    app.run(debug=True, port=5000)